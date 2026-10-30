import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { formatInboundEnvelope } from "openclaw/plugin-sdk/channel-inbound";
import type { OneBotMessageEvent, OneBotMessageSegment } from "../types.js";
import type { ResolvedOneBotAccount } from "../types.js";
import { isOwner } from "../policy.js";
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
export const FACE_NAMES: Record<string, string> = {
  "0": "惊讶",
  "1": "微笑",
  "2": "撇嘴",
  "3": "色",
  "4": "发呆",
  "5": "得意",
  "6": "流泪",
  "7": "害羞",
  "8": "闭嘴",
  "9": "睡",
  "10": "大哭",
  "11": "尴尬",
  "12": "发怒",
  "13": "调皮",
  "14": "呲牙",
  "15": "惊讶",
  "16": "难过",
  "17": "酷",
  "18": "冷汗",
  "19": "抓狂",
  "20": "吐",
  "21": "偷笑",
  "22": "可爱",
  "23": "白眼",
  "24": "傲慢",
  "25": "饥饿",
  "26": "困",
  "27": "惊恐",
  "28": "流汗",
  "29": "憨笑",
  "30": "大兵",
  "31": "奋斗",
  "32": "咒骂",
  "33": "疑问",
  "34": "嘘",
  "35": "晕",
  "36": "折磨",
  "37": "衰",
  "38": "骷髅",
  "39": "敲打",
  "40": "再见",
  "41": "擦汗",
  "42": "抠鼻",
  "43": "鼓掌",
  "44": "糗大了",
  "45": "坏笑",
  "46": "左哼哼",
  "47": "右哼哼",
  "48": "哈欠",
  "49": "鄙视",
  "50": "委屈",
  "51": "快哭了",
  "52": "阴险",
  "53": "亲亲",
  "54": "吓",
  "55": "可怜",
  "56": "菜刀",
  "57": "西瓜",
  "58": "啤酒",
  "59": "篮球",
  "60": "乒乓",
  "61": "咖啡",
  "62": "饭",
  "63": "猪头",
  "64": "玫瑰",
  "65": "凋谢",
  "66": "示爱",
  "67": "爱心",
  "68": "心碎",
  "69": "蛋糕",
  "70": "闪电",
  "71": "炸弹",
  "72": "刀",
  "73": "足球",
  "74": "便便",
  "75": "月亮",
  "76": "太阳",
  "77": "礼物",
  "78": "拥抱",
  "79": "强",
  "80": "弱",
  "81": "握手",
  "82": "胜利",
  "83": "抱拳",
  "84": "勾引",
  "85": "拳头",
  "86": "差劲",
  "87": "爱你",
  "88": "NO",
  "89": "OK",
  "90": "爱情",
  "91": "飞吻",
  "92": "跳跳",
  "93": "发抖",
  "94": "怄火",
  "95": "转圈",
  "96": "磕头",
  "97": "回头",
  "98": "跳绳",
  "99": "挥手",
  "100": "激动",
  "101": "街舞",
  "102": "献吻",
  "103": "左太极",
  "104": "右太极",
};

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
  /**
   * The actual sender's QQ id. Command authorization is decided per sender,
   * never per group: a `group:xxx` entry in allowFrom admits group messages
   * but must NOT grant command rights to every member (CVE-style hole where
   * anyone in the group could /reset the agent).
   */
  senderId: string;
}

export function resolveInboundCommandAuthorization(params: CommandAuthParams): boolean {
  const { pluginRuntime, cfg, allowFrom, senderId } = params;
  const hasAllowFrom = Array.isArray(allowFrom) && allowFrom.length > 0;

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
