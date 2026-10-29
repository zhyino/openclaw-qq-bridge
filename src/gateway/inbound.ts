import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { formatInboundEnvelope } from "openclaw/plugin-sdk/channel-inbound";
import type { OneBotMessageEvent, OneBotMessageSegment } from "../types.js";
import type { BufferedMessage } from "./batch.js";

/** Type-only handle on the plugin runtime (no runtime import: keeps mocking simple). */
export type OneBotRuntime = ReturnType<(typeof import("../runtime.js"))["getOneBotRuntime"]>;

export interface VoiceMedia {
  path: string;
  contentType: string;
}

// ── Segment extraction ───────────────────────────────────────────────────────

export function extractText(segments: OneBotMessageSegment[]): string {
  return segments
    .filter((seg) => seg.type === "text")
    .map((seg) => String(seg.data.text ?? ""))
    .join("");
}

export function extractImages(segments: OneBotMessageSegment[]): string[] {
  return segments
    .filter((seg) => seg.type === "image")
    .map((seg) => String(seg.data.url ?? seg.data.file ?? ""))
    .filter(Boolean);
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
}

export function resolveInboundCommandAuthorization(params: CommandAuthParams): boolean {
  const { pluginRuntime, cfg, allowFrom, peerId } = params;
  const hasAllowFrom = Array.isArray(allowFrom) && allowFrom.length > 0;
  const senderAllowedForCommands =
    hasAllowFrom && allowFrom!.some((pattern) => peerId === pattern || pattern === "*");

  const resolveCommandAuthorized = pluginRuntime.channel.commands?.resolveCommandAuthorizedFromAuthorizers;

  if (typeof resolveCommandAuthorized !== "function") {
    return senderAllowedForCommands;
  }

  return resolveCommandAuthorized({
    // 2026.10.8: commands.useAccessGroups retired; runtime defaults to true
    useAccessGroups: true,
    authorizers: [
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
  body: string;
  voiceMedia: VoiceMedia[];
}

export function buildInboundContext(params: InboundContextParams): {
  ctxPayload: Record<string, unknown>;
  sessionKey: string;
  agentId: string;
} {
  const { pluginRuntime, cfg, summary, accountId, accountAllowFrom, body, voiceMedia } = params;
  const { isGroup, senderId, senderName, peerId, address, combinedText, combinedImages } = summary;

  const route = pluginRuntime.channel.routing.resolveAgentRoute({
    cfg,
    channel: "onebot",
    accountId,
    peer: { kind: isGroup ? "group" : "direct", id: peerId },
  });

  const formatted = formatInboundEnvelope({
    channel: "OneBot",
    from: senderName,
    timestamp: summary.last.event.time * 1000,
    body,
    chatType: isGroup ? "group" : "direct",
    senderLabel: senderName,
    ...(combinedImages.length > 0 ? { imageUrls: combinedImages } : {}),
    envelope: pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(cfg),
  });

  const commandAuthorized = resolveInboundCommandAuthorization({
    pluginRuntime,
    cfg,
    allowFrom: accountAllowFrom,
    peerId,
  });

  const ctxPayload = pluginRuntime.channel.reply.finalizeInboundContext({
    Body: formatted,
    RawBody: combinedText,
    CommandBody: combinedText,
    From: address,
    To: address,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    SenderId: senderId,
    SenderName: senderName,
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
