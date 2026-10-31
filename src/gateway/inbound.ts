import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { formatInboundEnvelope } from "openclaw/plugin-sdk/channel-inbound";
import type { OneBotMessageEvent, OneBotMessageSegment } from "../types.js";
import type { ResolvedOneBotAccount } from "../types.js";
import { isOwner } from "../policy.js";
import { applySessionGeneration, getSessionGeneration } from "../session-generation.js";
import { FACE_NAMES_GENERATED } from "../face-names.generated.js";
import type { BufferedMessage } from "./batch.js";

/** Type-only handle on the plugin runtime (no runtime import: keeps mocking simple). */
export type OneBotRuntime = ReturnType<(typeof import("../runtime.js"))["getOneBotRuntime"]>;

export interface VoiceMedia {
  path: string;
  contentType: string;
}

// ── Segment extraction ───────────────────────────────────────────────────────

/**
 * QQ native emoji (face segment) id → name. Source: QQ's classic emoji set.
 * Unknown ids fall back to `[表情:<id>]` so nothing is silently dropped.
 */
export const FACE_NAMES: Record<string, string> = FACE_NAMES_GENERATED;

export interface ExtractTextOptions {
  /**
   * The bot's own QQ id. When set, `at` segments are decoded into markers
   * (`[被@]` / `[被@全体]` / `[@<qq>]`) and `face` segments into `[表情:<name>]`
   * instead of being silently dropped. Without it, behaviour matches the
   * original: only text segments are returned.
   */
  selfId?: number | string;
}

export function extractText(segments: OneBotMessageSegment[], options?: ExtractTextOptions): string {
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg.type === "text") {
      parts.push(String(seg.data.text ?? ""));
      continue;
    }
    if (options?.selfId == null) continue;
    if (seg.type === "at") {
      const qq = String(seg.data.qq ?? "");
      if (qq === "all") {
        parts.push("[被@全体]");
      } else if (qq !== "" && qq === String(options.selfId)) {
        parts.push("[被@]");
      } else if (qq !== "") {
        parts.push(`[@${qq}]`);
      }
      continue;
    }
    if (seg.type === "face") {
      const id = String(seg.data.id ?? "");
      parts.push(id ? `[表情:${FACE_NAMES[id] ?? id}]` : "[表情]");
    }
  }
  return parts.join("");
}

export function extractImages(segments: OneBotMessageSegment[]): string[] {
  return segments
    .filter((seg) => seg.type === "image")
    .map((seg) => String(seg.data.url ?? seg.data.file ?? ""))
    .filter(Boolean);
}

/**
 * Strip the structural prefixes `extractText` adds for @-mentions so a command
 * is still recognised as a command. "@bot /reset" becomes "[被@] /reset"; a
 * startsWith("/") check on the raw text would miss it and let an unprivileged
 * group member's command reach the agent as ordinary chat.
 */
export function stripStructuralPrefixes(text: string): string {
  let out = text.trim();
  for (;;) {
    const next = out.replace(/^(?:\[被@全体\]|\[被@\]|\[@\d+\])\s*/u, "");
    if (next === out) return out;
    out = next;
  }
}

export function extractRecordSegments(segments: OneBotMessageSegment[]): OneBotMessageSegment[] {
  return segments.filter((seg) => seg.type === "record");
}

// ── Batch summary ────────────────────────────────────────────────────────────

export interface BatchSummary {
  first: BufferedMessage;
  last: BufferedMessage;
  event: OneBotMessageEvent;
  isGroup: boolean;
  senderId: string;
  senderName: string;
  /** group:<group_id> or private:<user_id> — the identity used by allow lists */
  peerId: string;
  /** onebot:group:<id> / onebot:private:<id> — the address used by the SDK */
  address: string;
  /** All message ids in this batch (used to drop recalled messages). */
  messageIds: number[];
  combinedText: string;
  combinedImages: string[];
  combinedRecordSegments: OneBotMessageSegment[];
}

export function summarizeBatch(messages: BufferedMessage[]): BatchSummary {
  const first = messages[0];
  const last = messages[messages.length - 1];
  const event = first.event;
  const isGroup = event.message_type === "group";
  const senderId = String(event.user_id);
  const senderName = event.sender.card || event.sender.nickname || senderId;
  const peerId = isGroup ? `group:${event.group_id}` : `private:${senderId}`;

  return {
    first,
    last,
    event,
    isGroup,
    senderId,
    senderName,
    peerId,
    address: `onebot:${peerId}`,
    messageIds: messages.map((m) => m.event.message_id),
    combinedText: messages.map((m) => m.text).filter(Boolean).join("\n"),
    combinedImages: messages.flatMap((m) => m.images),
    combinedRecordSegments: messages.flatMap((m) => m.recordSegments),
  };
}

// ── Envelope decoration ──────────────────────────────────────────────────────

export function buildAttachmentInfo(
  images: string[],
  voiceMedia: VoiceMedia[],
  recordSegmentCount: number,
): string {
  let attachmentInfo = "";
  for (const img of images) {
    attachmentInfo += `\n[Image: ${img}]`;
  }
  if (voiceMedia.length > 0) {
    attachmentInfo += "\n<media:audio>";
  } else if (recordSegmentCount > 0) {
    // Download or conversion failed — tell the model something was there.
    attachmentInfo += "\n[语音]";
  }
  return attachmentInfo;
}

function buildMediaPayload(voiceMedia: VoiceMedia[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (voiceMedia.length === 0) return payload;

  payload.MediaPath = voiceMedia[0].path;
  payload.MediaType = voiceMedia[0].contentType;
  payload.MediaUrl = voiceMedia[0].path;

  if (voiceMedia.length > 1) {
    payload.MediaPaths = voiceMedia.map((v) => v.path);
    payload.MediaTypes = voiceMedia.map((v) => v.contentType);
    payload.MediaUrls = voiceMedia.map((v) => v.path);
  }
  return payload;
}

// ── Command authorization ────────────────────────────────────────────────────

export interface CommandAuthParams {
  pluginRuntime: OneBotRuntime;
  cfg: OpenClawConfig;
  allowFrom?: string[];
  peerId: string;
  /**
   * The actual sender's QQ id. Command authorization is decided per sender,
   * never per group: a `group:xxx` entry in allowFrom admits group messages
   * but must NOT grant command rights to every member (CVE-style hole where
   * anyone in the group could /reset the agent).
   */
  senderId: string;
  /** Resolved account — ownerQQ grants command rights independent of allowFrom. */
  account?: ResolvedOneBotAccount;
}

export function resolveInboundCommandAuthorization(params: CommandAuthParams): boolean {
  const { pluginRuntime, cfg, allowFrom, senderId, account } = params;
  const hasAllowFrom = Array.isArray(allowFrom) && allowFrom.length > 0;

  // The owner always has command rights — even when not listed in allowFrom.
  // The ingest gate (policy.isCommandSenderAuthorized) already uses this rule;
  // both layers must agree or the owner's commands are silently downgraded.
  const senderIsOwner = account ? isOwner(account, senderId) : false;

  // Command rights are personal. `group:xxx` / `group:*` entries only admit
  // inbound messages; a bare `*` still grants commands (explicit operator choice).
  const senderAllowedForCommands =
    hasAllowFrom &&
    allowFrom!.some((pattern) => {
      if (pattern === "*") return true;
      if (pattern.startsWith("group:")) return false;
      const normalized = pattern.startsWith("private:") ? pattern.slice("private:".length) : pattern;
      return normalized === senderId;
    });

  const resolveCommandAuthorized = pluginRuntime.channel.commands?.resolveCommandAuthorizedFromAuthorizers;

  if (typeof resolveCommandAuthorized !== "function") {
    return senderIsOwner || senderAllowedForCommands;
  }

  return resolveCommandAuthorized({
    // 2026.10.8: commands.useAccessGroups retired; runtime defaults to true
    useAccessGroups: true,
    authorizers: [
      { configured: senderIsOwner, allowed: senderIsOwner },
      {
        configured: hasAllowFrom,
        allowed: senderAllowedForCommands,
      },
    ],
    modeWhenAccessGroupsOff: hasAllowFrom ? "configured" : "deny",
  });
}

// ── Inbound context ──────────────────────────────────────────────────────────

export interface InboundContextParams {
  pluginRuntime: OneBotRuntime;
  cfg: OpenClawConfig;
  summary: BatchSummary;
  accountId: string;
  accountAllowFrom?: string[];
  /** Resolved account — used to derive sender identity (owner / user labels). */
  account?: ResolvedOneBotAccount;
  body: string;
  voiceMedia: VoiceMedia[];
}

/** A per-user display label attached to the sender name, e.g. "主人" / "女朋友". */
function resolveSenderIdentityLabel(
  account: ResolvedOneBotAccount | undefined,
  senderId: string,
): { isOwner: boolean; label?: string } {
  const ownerFlag = account ? isOwner(account, senderId) : false;
  if (ownerFlag) return { isOwner: ownerFlag, label: "主人" };

  const labels = account?.userLabels;
  if (labels && typeof labels === "object") {
    for (const [qq, label] of Object.entries(labels)) {
      if (String(qq) === String(senderId) && label) {
        return { isOwner: ownerFlag, label: String(label) };
      }
    }
  }
  return { isOwner: ownerFlag };
}

export function buildInboundContext(params: InboundContextParams): {
  ctxPayload: Record<string, unknown>;
  sessionKey: string;
  agentId: string;
} {
  const { pluginRuntime, cfg, summary, accountId, accountAllowFrom, account, body, voiceMedia } = params;
  const { isGroup, senderId, senderName, peerId, address, combinedText } = summary;

  // Derive who this sender is: owner gets "主人", configured userLabels get
  // their label, everyone else is just their name. Attached to the name so the
  // agent can recognise the person across chats, and surfaced as IsOwner.
  const identity = resolveSenderIdentityLabel(account, senderId);
  const labelledName = identity.label ? `${senderName}（${identity.label}）` : senderName;

  const route = pluginRuntime.channel.routing.resolveAgentRoute({
    cfg,
    channel: "onebot",
    accountId,
    peer: { kind: isGroup ? "group" : "direct", id: peerId },
  });

  // The host blocks work on archived sessions and derives one fixed key per
  // peer. After a user archives the conversation, every message would fail
  // forever; a bumped generation routes to `<key>:g<N>` (a fresh session).
  const sessionKey = applySessionGeneration(route.sessionKey, getSessionGeneration(peerId));

  const formatted = formatInboundEnvelope({
    channel: "OneBot",
    from: labelledName,
    timestamp: summary.last.event.time * 1000,
    body,
    chatType: isGroup ? "group" : "direct",
    sender: { id: senderId, name: labelledName },
    envelope: pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(cfg),
  });

  const commandAuthorized = resolveInboundCommandAuthorization({
    pluginRuntime,
    cfg,
    allowFrom: accountAllowFrom,
    peerId,
    senderId,
    account,
  });

  const ctxPayload = pluginRuntime.channel.reply.finalizeInboundContext({
    Body: formatted,
    RawBody: combinedText,
    CommandBody: combinedText,
    From: address,
    To: address,
    SessionKey: sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    SenderId: senderId,
    SenderName: labelledName,
    IsOwner: identity.isOwner,
    Provider: "onebot",
    Surface: "onebot",
    MessageSid: String(summary.last.event.message_id),
    Timestamp: summary.last.event.time * 1000,
    CommandAuthorized: commandAuthorized,
    CommandSource: "text",
    OriginatingChannel: "onebot",
    OriginatingTo: address,
    ...buildMediaPayload(voiceMedia),
  }) as Record<string, unknown>;

  return { ctxPayload, sessionKey: route.sessionKey, agentId: route.agentId };
}
