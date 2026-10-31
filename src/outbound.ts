/**
 * Outbound transport for OneBot 11.
 *
 * Structure rule (learned the hard way over three releases): the policy gate
 * and the media path guard are NOT applied at call sites. Every send funnels
 * through `dispatchSend()`, and every media path funnels through
 * `resolveNapCatMediaUri()`. A new caller cannot forget the guard, because
 * there is no other way to reach the socket.
 *
 *   sendText ─┐
 *   sendImage ─┼─> dispatchSend(account, to, segments)  ← whitelist + audit
 *   sendRecord ┤        └─> callApi()
 *   uploadFile ┘
 *
 *   sendImage/sendRecord/uploadFile
 *        └─> resolveNapCatMediaUri()  ← media root guard + staging
 */
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, posix, relative, sep } from "node:path";
import type { ResolvedOneBotAccount, OneBotApiResponse, OneBotMessageSegment } from "./types.js";
import { assertOutboundAllowed, assertSafeMediaPath, isSystemNotice } from "./policy.js";
import { parseTarget } from "./target.js";
import {
  STAGED_MEDIA_DIRNAME,
  STAGED_MEDIA_MAX_AGE_MS,
  fileUriToPath,
  resolveAccountDirs,
} from "./paths.js";

export interface OutboundContext {
  to: string;
  text: string;
  accountId?: string | null;
  replyToId?: string | null;
  /** Exempt this send from outboundRateLimit (inbound @-mention / explicit reply). */
  exemptRateLimit?: boolean;
  /** Send even if the text looks like a system notice (plugin diagnostics). */
  bypassMute?: boolean;
  account: ResolvedOneBotAccount;
}

export interface OutboundResult {
  channel: string;
  messageId?: string;
  timestamp?: string | number;
  error?: string;
  /** Deliberate silent drop: not a failure, nothing was sent. */
  suppressed?: "system-notice" | "rate-limit";
}

export type OneBotReactionResult = {
  channel: "onebot";
  messageId: string | number;
  emojiId: string | number;
  ok: boolean;
  error?: string;
};

/**
 * Thrown when a send is a muted system notice. Callers treat it as a silent
 * no-op (no error notice, no warn log) — the message is dropped on purpose.
 */
export class SystemNoticeMutedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SystemNoticeMutedError";
  }
}

/**
 * Thrown when a reply is rate-limited (outbound anti-flood guard). Callers
 * treat it as a silent no-op — the reply is intentionally dropped so two bots
 * cannot loop into a flood.
 */
export class OutboundRateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundRateLimitedError";
  }
}

const CONTROL_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 120_000;

// Outbound anti-flood: `to -> last admitted send timestamp`. When enabled
// (outboundRateLimit), a reply to the same target is admitted at most once
// per interval, so two bots cannot loop into a flood. Explicit replies
// (replyToId present — e.g. answering an @) are exempt.
//
// Entries older than the configured interval are pruned on write so the map
// does not grow without bound over a long-lived gateway.
const outboundLastSent = new Map<string, number>();

function isOutboundRateLimited(
  account: ResolvedOneBotAccount,
  to: string,
  exempt?: boolean,
): boolean {
  const intervalSec = account.outboundRateLimit;
  if (!intervalSec) return false;
  // Only a genuine inbound @-mention / explicit quote may bypass the limit.
  // Host-implicit replyToId (filled for every reply by default) must NOT.
  if (exempt) return false;
  const now = Date.now();
  const last = outboundLastSent.get(to) ?? 0;
  return now - last < intervalSec * 1000;
}

/**
 * Start the rate-limit window for a target. Called only AFTER a send actually
 * succeeded: a failed send (network error, OneBot retcode) must not consume the
 * window, or the retry would be throttled away.
 */
function markOutboundSent(account: ResolvedOneBotAccount, to: string): void {
  const intervalSec = account.outboundRateLimit;
  if (!intervalSec) return;
  const now = Date.now();
  outboundLastSent.set(to, now);
  // Opportunistic prune: drop entries older than the interval so the map stays
  // bounded by the number of targets that were active within the window.
  if (outboundLastSent.size > 128) {
    for (const [key, ts] of outboundLastSent) {
      if (now - ts >= intervalSec * 1000) outboundLastSent.delete(key);
    }
  }
}

// ── Transport ────────────────────────────────────────────────────────────────

async function callApi(
  account: ResolvedOneBotAccount,
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs: number = CONTROL_TIMEOUT_MS,
): Promise<OneBotApiResponse> {
  const url = `${account.httpUrl}/${endpoint}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (account.accessToken) {
    headers.Authorization = `Bearer ${account.accessToken}`;
  }

  // Every HTTP call is bounded: an unreachable OneBot endpoint must not wedge
  // the reply pipeline (the 90s response watchdog would hang on the same fetch).
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`OneBot API error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as OneBotApiResponse;
}

function ensureApiSuccess(result: OneBotApiResponse, endpoint: string): OneBotApiResponse {
  if (result.retcode !== 0 || result.status === "failed") {
    throw new Error(
      `OneBot API ${endpoint} failed: ${result.retcode} ${result.message ?? result.wording ?? ""}`.trim(),
    );
  }
  return result;
}

/**
 * The single outbound choke point. Nothing reaches the OneBot socket without
 * passing the target whitelist here.
 */
async function dispatchSend(
  account: ResolvedOneBotAccount,
  to: string,
  segments: OneBotMessageSegment[],
  options: { auditText?: string; timeoutMs?: number; bypassMute?: boolean } = {},
): Promise<{ result: OneBotApiResponse; endpoint: string }> {
  // System notices are muted before the whitelist/audit gates so they never
  // even reach the OneBot socket when the operator doesn't want them. The
  // plugin's own diagnostics opt out via bypassMute — muting those would leave
  // the user with total silence when something breaks.
  if (
    !options.bypassMute &&
    account.muteSystemNotices &&
    options.auditText != null &&
    isSystemNotice(options.auditText)
  ) {
    throw new SystemNoticeMutedError("system notice muted by muteSystemNotices");
  }

  const gate = assertOutboundAllowed(account, to, options.auditText);
  if (!gate.allowed) {
    throw new Error(`outbound blocked by policy: ${gate.reason ?? "not allowed"}`);
  }

  const target = parseTarget(to);
  const endpoint = target.type === "private" ? "send_private_msg" : "send_group_msg";
  const idField = target.type === "private" ? "user_id" : "group_id";

  const result = await callApi(
    account,
    endpoint,
    { [idField]: target.id, message: segments },
    options.timeoutMs,
  );
  return { result, endpoint };
}

function normalizeMessageRef(value: string | number): string | number {
  if (typeof value === "number") return value;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

/**
 * `file://` URLs are accepted from agents and are not always valid on every
 * platform (a POSIX-style `file:///tmp/a.png` throws on Windows). Degrade to
 * the raw string instead of letting an uncaught TypeError escape.
 */
function stripFileScheme(filePath: string): string {
  return fileUriToPath(filePath);
}

function toFileUri(filePath: string): string {
  return filePath.startsWith("file://") ? filePath : `file://${filePath}`;
}

function toPosixPath(filePath: string): string {
  return filePath.split(sep).join("/");
}

function isWithinDir(parentDir: string, candidatePath: string): boolean {
  const rel = relative(parentDir, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function pruneStagedMedia(rootDir: string): Promise<void> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    const cutoff = Date.now() - STAGED_MEDIA_MAX_AGE_MS;
    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(rootDir, entry.name);
        if (entry.isDirectory()) {
          await pruneStagedMedia(entryPath);
          return;
        }
        const info = await stat(entryPath);
        if (info.mtimeMs < cutoff) {
          await rm(entryPath, { force: true });
        }
      }),
    );
  } catch {
    // Best-effort cleanup only.
  }
}

/**
 * Media choke point. Resolves a local path to the URI NapCat should read, and
 * is the only place allowed to touch an untrusted path before it leaves.
 */
export async function resolveNapCatMediaUri(
  account: ResolvedOneBotAccount,
  filePath: string,
  kind: "audio" | "images" | "files",
): Promise<string> {
  const normalizedPath = assertSafeMediaPath(account, stripFileScheme(filePath));
  const { sharedDir, containerSharedDir, stagingRoot } = resolveAccountDirs(account);

  if (normalizedPath.startsWith(`${containerSharedDir}/`) || normalizedPath === containerSharedDir) {
    return toFileUri(normalizedPath);
  }

  if (!isAbsolute(normalizedPath)) {
    return toFileUri(filePath);
  }

  if (isWithinDir(sharedDir, normalizedPath)) {
    const rel = toPosixPath(relative(sharedDir, normalizedPath));
    return toFileUri(posix.join(containerSharedDir, rel));
  }

  const stagedDir = join(stagingRoot, kind);
  await mkdir(stagedDir, { recursive: true });
  await chmod(stagedDir, 0o700).catch(() => {});

  const ext = extname(normalizedPath);
  const base =
    basename(normalizedPath, ext)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "media";
  const stagedPath = join(stagedDir, `${Date.now()}-${randomUUID()}-${base}${ext || ""}`);
  await copyFile(normalizedPath, stagedPath);
  await chmod(stagedPath, 0o600).catch(() => {});

  void pruneStagedMedia(stagingRoot);

  const rel = toPosixPath(relative(sharedDir, stagedPath));
  return toFileUri(posix.join(containerSharedDir, rel));
}

/**
 * NapCat/go-cqhttp parse `[CQ:...]` inside text segments, so an agent induced
 * into echoing `[CQ:image,file=http://attacker/x.png]` would emit real rich
 * media. Rewriting the colon neutralises the syntax; actual media must go
 * through sendImage/sendRecord.
 */
function escapeCqText(text: string): string {
  return text.replace(/\[CQ:/gi, "[CQ：");
}

/**
 * Whitelisted rich segments in outbound text:
 *  - `[CQ:face,id=<n>]`   → OneBot face (QQ native emoji) — carries only an id
 *  - `[CQ:at,qq=<n>]`     → OneBot at (mention a member) — carries only a qq id
 *  - `[@<n>]`             → same as at, friendlier shorthand for the model
 * Every OTHER `[CQ:...]` is neutralised by escapeCqText — an agent echoing
 * `[CQ:image,file=http://attacker/x.png]` must never emit real rich media.
 * face/at are safe to whitelist: they carry only numeric ids.
 *
 * When `replyToId` is provided, a OneBot `reply` segment is prepended so the
 * message shows as a quote-reply to that message id.
 */
export function buildMessage(text: string, replyToId?: string | null): OneBotMessageSegment[] {
  const segments: OneBotMessageSegment[] = [];
  if (replyToId != null && String(replyToId).trim() !== "") {
    segments.push({ type: "reply", data: { id: String(replyToId).trim() } });
  }
  if (!text.trim()) return segments;

  // One combined scan keeps segment order: text/face/at interleave correctly.
  const RICH_RE = /\[CQ:face,\s*id=(\d+)\]|\[CQ:at,\s*qq=(\d+)\]|\[@(\d+)\]/gi;
  let lastIndex = 0;
  let pendingText = "";
  let match: RegExpExecArray | null;

  const flushText = () => {
    if (pendingText.trim()) {
      segments.push({ type: "text", data: { text: escapeCqText(pendingText) } });
      pendingText = "";
    }
  };

  RICH_RE.lastIndex = 0;
  while ((match = RICH_RE.exec(text)) !== null) {
    pendingText += text.slice(lastIndex, match.index);
    flushText();
    if (match[1] !== undefined) {
      segments.push({ type: "face", data: { id: match[1] } });
    } else {
      const qq = match[2] !== undefined ? match[2] : match[3];
      if (qq !== undefined) {
        segments.push({ type: "at", data: { qq } });
      }
    }
    lastIndex = RICH_RE.lastIndex;
  }
  pendingText += text.slice(lastIndex);
  flushText();

  return segments;
}

// ── Public senders ───────────────────────────────────────────────────────────

export async function sendText(ctx: OutboundContext): Promise<OutboundResult> {
  const { to, text, account, replyToId, exemptRateLimit, bypassMute } = ctx;

  if (!account.httpUrl) {
    return { channel: "onebot", error: "OneBot not configured (missing httpUrl)" };
  }

  try {
    // Outbound anti-flood: drop a reply to a target sent too soon after the
    // previous one (silently, like a muted notice). Only an inbound @-mention
    // or explicit quote exempts it.
    if (isOutboundRateLimited(account, to, exemptRateLimit)) {
      throw new OutboundRateLimitedError(
        `outbound rate-limited: ${to} (interval ${account.outboundRateLimit}s)`,
      );
    }

    const { result } = await dispatchSend(account, to, buildMessage(text, replyToId), {
      auditText: text,
      bypassMute,
    });

    if (result.retcode !== 0) {
      return {
        channel: "onebot",
        error: `OneBot API returned error: ${result.retcode} ${result.message ?? result.wording ?? ""}`.trim(),
      };
    }

    const data = result.data as { message_id?: number } | null;
    // The send succeeded: only now does it consume the rate-limit window.
    markOutboundSent(account, to);
    return {
      channel: "onebot",
      messageId: data?.message_id != null ? String(data.message_id) : undefined,
    };
  } catch (err) {
    // A muted system notice or a rate-limited reply is a deliberate silent
    // drop: no error, no log — but callers get an explicit `suppressed` flag so
    // the adapter layer can tell "nothing sent on purpose" from "send failed".
    if (err instanceof SystemNoticeMutedError) {
      return { channel: "onebot", suppressed: "system-notice" };
    }
    if (err instanceof OutboundRateLimitedError) {
      return { channel: "onebot", suppressed: "rate-limit" };
    }
    return { channel: "onebot", error: err instanceof Error ? err.message : String(err) };
  }
}

async function sendMediaSegment(
  account: ResolvedOneBotAccount,
  targetType: "private" | "group",
  targetId: number,
  kind: "image" | "record",
  filePath: string,
): Promise<OneBotApiResponse> {
  // Defense in depth: the target is re-checked inside dispatchSend, but the
  // media-specific message tells the operator which path was refused.
  const gate = assertOutboundAllowed(account, `${targetType}:${targetId}`);
  if (!gate.allowed) {
    throw new Error(`media send blocked by policy: ${gate.reason ?? "not allowed"}`);
  }

  const mediaUri = await resolveNapCatMediaUri(account, filePath, kind === "image" ? "images" : "audio");
  const { result, endpoint } = await dispatchSend(account, `${targetType}:${targetId}`, [
    { type: kind, data: { file: mediaUri } },
  ]);
  return ensureApiSuccess(result, endpoint);
}

export async function sendImage(
  account: ResolvedOneBotAccount,
  targetType: "private" | "group",
  targetId: number,
  filePath: string,
): Promise<OneBotApiResponse> {
  return sendMediaSegment(account, targetType, targetId, "image", filePath);
}

export async function sendRecord(
  account: ResolvedOneBotAccount,
  targetType: "private" | "group",
  targetId: number,
  filePath: string,
): Promise<OneBotApiResponse> {
  return sendMediaSegment(account, targetType, targetId, "record", filePath);
}

export async function uploadFile(
  account: ResolvedOneBotAccount,
  targetType: "private" | "group",
  targetId: number,
  filePath: string,
  fileName: string,
): Promise<OneBotApiResponse> {
  const gate = assertOutboundAllowed(account, `${targetType}:${targetId}`);
  if (!gate.allowed) {
    throw new Error(`media send blocked by policy: ${gate.reason ?? "not allowed"}`);
  }

  const mediaUri = await resolveNapCatMediaUri(account, filePath, "files");
  const endpoint = targetType === "private" ? "upload_private_file" : "upload_group_file";
  const idField = targetType === "private" ? "user_id" : "group_id";

  // Uploads need a longer budget than control calls (large files, slow links).
  return ensureApiSuccess(
    await callApi(
      account,
      endpoint,
      { [idField]: targetId, file: mediaUri, name: fileName },
      UPLOAD_TIMEOUT_MS,
    ),
    endpoint,
  );
}

export async function reactToMessage(
  account: ResolvedOneBotAccount,
  messageId: string | number,
  emojiId: string | number,
): Promise<OneBotReactionResult> {
  if (!account.httpUrl) {
    return {
      channel: "onebot",
      messageId,
      emojiId,
      ok: false,
      error: "OneBot not configured (missing httpUrl)",
    };
  }

  try {
    const result = await callApi(account, "set_msg_emoji_like", {
      message_id: normalizeMessageRef(messageId),
      emoji_id: normalizeMessageRef(emojiId),
    });

    if (result.retcode !== 0) {
      return {
        channel: "onebot",
        messageId,
        emojiId,
        ok: false,
        error: `OneBot API returned error: ${result.retcode} ${result.message ?? result.wording ?? ""}`.trim(),
      };
    }

    return { channel: "onebot", messageId, emojiId, ok: true };
  } catch (err) {
    return {
      channel: "onebot",
      messageId,
      emojiId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
