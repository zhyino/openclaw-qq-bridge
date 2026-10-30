/**
 * QQ Bridge policy layer.
 *
 * Three independent decisions live here, deliberately as pure functions so
 * they can be tested without a socket or a filesystem:
 *
 *  1. target matching  — inbound allowFrom and outbound allow/deny use the
 *     SAME matcher (`matchesTargetPattern`). They used to be two hand-rolled
 *     `.some(peerId === p || p === "*")` loops in different files, which made
 *     `group:*` work outbound and silently fail inbound.
 *  2. reply audit      — block local paths / credential shapes before send.
 *  3. media path guard — only files under a known media root may leave.
 */
import { existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ResolvedOneBotAccount } from "./types.js";
import { resolveMediaRoots } from "./paths.js";

export {
  parseTarget,
  targetKey,
  matchesTargetPattern,
  type TargetType,
} from "./target.js";
import { matchesAnyTarget, parseTarget, targetKey, type TargetType } from "./target.js";

function matchesAny(patterns: string[] | undefined, key: string, type: TargetType): boolean {
  return matchesAnyTarget(patterns, key, type);
}

// ── System notice suppression ────────────────────────────────────────────────

/**
 * System notices the agent/host injects into chat and the operator usually
 * does not want to see (they are also a prompt-injection echo surface when
 * replayed verbatim). Muted at the single outbound choke point when
 * `muteSystemNotices` is enabled (default).
 *
 * Matches:
 *  - `[OpenClaw] ...` — plugin's own error/processing notices
 *  - `💾 Learned: ...` — host skill-learning notifications (with the fixed
 *    "Say \"undo\" to revert" trailer)
 *  - `⚠️ Agent couldn't generate a response ...` — host empty/failed turn
 *    notifications (OpenClaw itself filters these from transcripts)
 */
export function isSystemNotice(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith("[OpenClaw]")) return true;
  if (t.startsWith("💾 Learned:") || t.startsWith("💾 Learned ")) return true;
  if (t.includes("Say \"undo\" to revert this skill change")) return true;
  if (/^⚠️?\s*Agent couldn'?t generate a response/i.test(t)) return true;
  if (t.includes("couldn't generate a response") || t.includes("could not generate a response")) return true;
  return false;
}

// ── Inbound ──────────────────────────────────────────────────────────────────

export interface InboundDecision {
  allowed: boolean;
  reason?: "not-listed";
}

/**
 * Inbound gate. An empty/missing allowFrom means "accept everyone" — kept for
 * back-compat, but flagged by `validateOneBotConfig` at startup because it is
 * the single most dangerous default this plugin has.
 */
export function checkInboundAllowed(
  account: ResolvedOneBotAccount,
  peerId: string,
): InboundDecision {
  const patterns = account.allowFrom;
  if (!patterns || patterns.length === 0) return { allowed: true };

  const { type, id } = parseTarget(peerId);
  if (matchesAny(patterns, targetKey(type, id), type)) return { allowed: true };
  return { allowed: false, reason: "not-listed" };
}

// ── Outbound ─────────────────────────────────────────────────────────────────

/**
 * Rules (qq-bridge semantics):
 *  - deny matches            -> DENY (wins over allow)
 *  - allow non-empty, no hit -> DENY
 *  - allow empty/undefined   -> ALLOW (legacy: allowFrom governs inbound only)
 */
export function checkOutboundTarget(
  account: ResolvedOneBotAccount,
  to: string,
): { allowed: boolean; reason?: string } {
  const { type, id } = parseTarget(to);
  const key = targetKey(type, id);

  if (matchesAny(account.outboundDeny, key, type)) {
    return { allowed: false, reason: `target ${key} is in outbound deny list` };
  }

  const allow = account.outboundAllow ?? [];
  if (allow.length === 0) {
    return { allowed: true };
  }

  if (matchesAny(allow, key, type)) {
    return { allowed: true };
  }
  return { allowed: false, reason: `target ${key} is not in outbound allow list` };
}

// ── Reply audit ──────────────────────────────────────────────────────────────

const LOCAL_PATH_PATTERNS = [
  /(^|[\s"'=:,])C:\\/i, // Windows absolute path
  /(^|[\s"'=:,])\/[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_.-]+)+/, // Unix absolute path
  /(^|[\s"'=:,])\/home\//i,
  /(^|[\s"'=:,])\/Users\//i,
  /(^|[\s"'=:,])\/tmp\//i,
  /(^|[\s"'=:,])\/etc\//i,
  /(^|[\s"'=:,])\/var\//i,
];

const CREDENTIAL_PATTERNS = [
  /api[_-]?key\s*[:=]\s*\S+/i,
  /sk-[A-Za-z0-9]{16,}/,
  /token\s*[:=]\s*[A-Za-z0-9]{16,}/i,
  /password\s*[:=]\s*\S+/i,
  /secret\s*[:=]\s*\S+/i,
  /authorization\s*[:=]\s*Bearer\s+\S+/i,
  /AKIA[0-9A-Z]{16}/, // AWS access key
  /gh[pousr]_[A-Za-z0-9]{20,}/i, // GitHub tokens
];

export interface AuditResult {
  ok: boolean;
  reason?: string;
  matched?: string;
}

export function auditReply(text: string): AuditResult {
  if (!text || typeof text !== "string") return { ok: true };

  for (const re of LOCAL_PATH_PATTERNS) {
    const m = text.match(re);
    if (m) {
      return { ok: false, reason: "reply contains a local path", matched: m[0].slice(0, 60) };
    }
  }

  for (const re of CREDENTIAL_PATTERNS) {
    const m = text.match(re);
    if (m) {
      return {
        ok: false,
        reason: "reply contains a credential-like pattern",
        matched: m[0].slice(0, 40),
      };
    }
  }

  return { ok: true };
}

/**
 * Redact instead of dropping. Used for operator-facing error text: letting
 * `auditReply` swallow the whole message leaves the user staring at silence,
 * which is worse than a redacted one.
 */
export function redactSensitive(text: string): string {
  let out = text;
  for (const re of CREDENTIAL_PATTERNS) {
    out = out.replace(new RegExp(re.source, "gi"), "[redacted]");
  }
  for (const re of LOCAL_PATH_PATTERNS) {
    // every LOCAL_PATH_PATTERN captures the leading separator in group 1 —
    // keep it so redaction does not glue words together
    out = out.replace(new RegExp(re.source, "gi"), (_m: string, prefix: string) => `${prefix ?? ""}[path]`);
  }
  return out;
}

// ── Owner / control commands ─────────────────────────────────────────────────

export function isOwner(account: ResolvedOneBotAccount, senderId: number | string): boolean {
  const owner = account.ownerQQ;
  if (!owner) return false;
  return String(owner) === String(senderId);
}

export function isControlCommand(text: string): boolean {
  return /^\/(silent|active|role|mode)\b/i.test(text.trim());
}

/**
 * Whether a sender is allowed to issue OpenClaw/plugin commands at all.
 * Command rights are personal: the owner, or an individual QQ id listed in
 * allowFrom (bare id or private:), or an explicit `*`. A `group:xxx` entry
 * admits messages but never grants command rights — otherwise any group member
 * could `/reset` / `/new` / `/model` the agent.
 */
export function isCommandSenderAuthorized(
  account: ResolvedOneBotAccount,
  senderId: string,
): boolean {
  if (isOwner(account, senderId)) return true;

  const patterns = account.allowFrom;
  if (!patterns || patterns.length === 0) return false;

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith("group:")) return false;
    const normalized = pattern.startsWith("private:") ? pattern.slice("private:".length) : pattern;
    return normalized === senderId;
  });
}

/**
 * Whether a sender is on the manual ignore list (`ignoreFrom`). This is the
 * bot-loop guard: messages from these QQ ids are dropped before anything else.
 */
export function isIgnoredSender(account: ResolvedOneBotAccount, senderId: string): boolean {
  const list = account.ignoreFrom;
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.some((id) => String(id).trim() === String(senderId));
}

// ── Unified outbound gate ────────────────────────────────────────────────────

export interface OutboundGateResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Called by every outbound path at transport time. Text additionally passes
 * the reply audit; media passes the path guard inside `resolveNapCatMediaUri`.
 */
export function assertOutboundAllowed(
  account: ResolvedOneBotAccount,
  to: string,
  text?: string,
): OutboundGateResult {
  const target = checkOutboundTarget(account, to);
  if (!target.allowed) {
    return { allowed: false, reason: target.reason ?? "target not allowed" };
  }
  if (account.replyAudit && text) {
    const audit = auditReply(text);
    if (!audit.ok) {
      return { allowed: false, reason: audit.reason ?? "audit failed" };
    }
  }
  return { allowed: true };
}

// ── Media path guard ─────────────────────────────────────────────────────────

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Resolve a media path for sending, or throw.
 *
 * Two checks, both required:
 *   lexical — the normalised path sits under a known media root;
 *   real    — the path AFTER following symlinks still sits there, so a link
 *             inside the shared dir cannot point at ~/.openclaw/openclaw.json.
 */
export function assertSafeMediaPath(
  account: ResolvedOneBotAccount,
  mediaPath: string,
): string {
  const abs = resolve(mediaPath);
  const roots = resolveMediaRoots(account);

  if (!roots.some((root) => isInside(root, abs))) {
    throw new Error(`media path not allowed: ${abs} is outside controlled media roots`);
  }
  if (!existsSync(abs)) {
    throw new Error(`media path not found: ${abs}`);
  }

  const real = realpathSync(abs);
  const realInside = roots.some((root) => {
    let realRoot = root;
    try {
      realRoot = realpathSync(root);
    } catch {
      // root may not exist yet; fall back to the lexical form
    }
    return isInside(realRoot, real);
  });
  if (!realInside) {
    throw new Error(`media path not allowed: symlink escapes controlled directory (${abs})`);
  }

  return abs;
}
