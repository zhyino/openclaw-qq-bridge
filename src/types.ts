/**
 * OneBot 11 account configuration (raw config values)
 */
/** Per-group wake overrides, keyed by group id or "*" (default for unlisted). */
export interface OneBotGroupWakeConfig {
  /** all = answer everything; mention = only @/nickname/poke; sampled = mention + probability. */
  wakePolicy?: "all" | "mention" | "sampled";
  /** Probability for sampled groups (0-1). Default 0.05. */
  wakeProbability?: number;
  /** Host-native spelling of "only when mentioned". */
  requireMention?: boolean;
}

export interface OneBotAccountConfig {
  enabled?: boolean;
  name?: string;
  /** WebSocket URL for inbound events, e.g. ws://localhost:3001 */
  wsUrl?: string;
  /** HTTP API URL for outbound messages, e.g. http://localhost:3001 */
  httpUrl?: string;
  /** Optional access token for authentication */
  accessToken?: string;
  /** Host directory mounted into the NapCat container for outbound files */
  sharedDir?: string;
  /** Container path that maps to the shared host directory */
  containerSharedDir?: string;
  /** Whitelist of allowed senders, e.g. ["private:12345", "group:67890", "*"] */
  allowFrom?: string[];
  /** Deprecated alias for legacy configs; use allowFrom instead */
  groupAllowFrom?: string[];
  /** Automatically react to inbound group messages (disabled by default) */
  groupAutoReact?: boolean;
  /** Owner QQ id: admin who can use control commands (/silent /active /role) */
  ownerQQ?: string;
  /** Outbound allowlist: targets the agent may send to. private:<id> / group:<id> / * */
  outboundAllow?: string[];
  /** Outbound denylist: targets the agent may NEVER send to. Overrides outboundAllow. */
  outboundDeny?: string[];
  /** Enable reply audit: block replies containing local paths or credential patterns. Default true */
  replyAudit?: boolean;
  /** Extra directories the agent may send media files from (besides sharedDir). */
  mediaAllowDirs?: string[];
  /** Enable QQ-zone/profile write tools (send/delete/like/comment/delete/profile/status). Default false */
  qzoneWrite?: boolean;
  /** Mute system notices (`[OpenClaw] ...`, `💾 Learned: ...`) from reaching the chat. Default true */
  muteSystemNotices?: boolean;
  /** QQ ids whose messages are ignored entirely (bot-loop guard, manual list). */
  ignoreFrom?: string[];
  /**
   * Display labels per QQ id, e.g. `{"10001": "主人", "10002": "女朋友"}`.
   * Attached to the sender name in inbound context so the agent can recognise
   * the person across chats.
   */
  userLabels?: Record<string, string>;
  /**
   * Outbound anti-flood: minimum seconds between replies to the same target
   * (`group:<id>` / `private:<id>`). Explicit replies (replyToId present) are
   * exempt. Default 0 = disabled.
   */
  outboundRateLimit?: number;
  /** Natural reply delay (seconds) before responding to an inbound batch. Default 0 = no delay. */
  replyDelaySec?: number;
  /** React to QQ "poke" (戳一戳) as an inbound message when it targets the bot. Default true. */
  pokeReply?: boolean;
  /** Default group wake policy. Default "all" (answer every allowed message). */
  wakePolicy?: "all" | "mention" | "sampled";
  /** Probability used when wakePolicy is "sampled". Default 0.05. */
  wakeProbability?: number;
  /** Per-group wake overrides keyed by group id or "*". */
  groups?: Record<string, OneBotGroupWakeConfig>;
  /** QQ/NapCat emoji id used for automatic group reactions */
  groupAutoReactEmojiId?: string | number;
}

/**
 * Resolved OneBot account (ready to use)
 */
export interface ResolvedOneBotAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  wsUrl: string;
  httpUrl: string;
  accessToken?: string;
  allowFrom?: string[];
  groupAutoReact: boolean;
  groupAutoReactEmojiId: string | number;
  ownerQQ?: string;
  outboundAllow?: string[];
  outboundDeny?: string[];
  replyAudit: boolean;
  sharedDir?: string;
  mediaAllowDirs?: string[];
  qzoneWrite: boolean;
  /** Mute system notices from reaching the chat (default true) */
  muteSystemNotices: boolean;
  /** QQ ids whose messages are ignored entirely (bot-loop guard, manual list). */
  ignoreFrom?: string[];
  /** Display labels per QQ id (e.g. "主人" / "女朋友") attached to sender names. */
  userLabels?: Record<string, string>;
  /** Outbound anti-flood: minimum seconds between replies to the same target. 0 = disabled. */
  outboundRateLimit: number;
  /** Natural reply delay (seconds) before responding to an inbound batch. Default 0 = no delay. */
  replyDelaySec: number;
  /** React to QQ "poke" (戳一戳) as an inbound message when it targets the bot. */
  pokeReply: boolean;
  /** Default group wake policy. */
  wakePolicy: "all" | "mention" | "sampled";
  /** Probability used when wakePolicy is "sampled". */
  wakeProbability: number;
  /** Per-group wake overrides. */
  groups?: Record<string, OneBotGroupWakeConfig>;
  config: OneBotAccountConfig;
}

// ── OneBot 11 Event Types ──

/**
 * OneBot 11 message segment (CQ message array element)
 */
export interface OneBotMessageSegment {
  type: string;
  data: Record<string, unknown>;
}

/**
 * OneBot 11 sender info
 */
export interface OneBotSender {
  user_id: number;
  nickname?: string;
  card?: string;
  sex?: string;
  age?: number;
  role?: string;
}

/**
 * OneBot 11 message event
 */
export interface OneBotMessageEvent {
  post_type: "message";
  message_type: "private" | "group";
  sub_type: string;
  message_id: number;
  user_id: number;
  group_id?: number;
  message: OneBotMessageSegment[];
  raw_message: string;
  sender: OneBotSender;
  self_id: number;
  time: number;
  font?: number;
}

/**
 * OneBot 11 notice event
 */
export interface OneBotNoticeEvent {
  post_type: "notice";
  notice_type: string;
  sub_type?: string;
  self_id: number;
  time: number;
  [key: string]: unknown;
}

/**
 * OneBot 11 meta event (lifecycle, heartbeat)
 */
export interface OneBotMetaEvent {
  post_type: "meta_event";
  meta_event_type: "lifecycle" | "heartbeat";
  sub_type?: string;
  self_id: number;
  time: number;
  status?: Record<string, unknown>;
  interval?: number;
}

/**
 * Any OneBot 11 event
 */
export type OneBotEvent = OneBotMessageEvent | OneBotNoticeEvent | OneBotMetaEvent;

/**
 * OneBot 11 API response
 */
export interface OneBotApiResponse {
  status: string;
  retcode: number;
  data: unknown;
  message?: string;
  wording?: string;
  echo?: string;
}
