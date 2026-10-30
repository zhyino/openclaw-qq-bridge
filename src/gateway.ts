/**
 * OneBot gateway: inbound WebSocket lifecycle.
 *
 * Responsibilities kept here: connect, authenticate, reconnect, parse, and
 * hand a message to the batcher. Message handling itself lives in
 * `gateway/dispatch.ts` (see that file for why).
 */
import WebSocket from "ws";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type {
  ResolvedOneBotAccount,
  OneBotEvent,
  OneBotMessageEvent,
} from "./types.js";
import { getOneBotRuntime } from "./runtime.js";
import { reactToMessage, sendText as sendOutboundText } from "./outbound.js";
import { checkInboundAllowed, isCommandSenderAuthorized, isControlCommand, isIgnoredSender } from "./policy.js";
import { handleControlCommand } from "./owner-control.js";
import { MessageBatcher, type BufferedMessage } from "./gateway/batch.js";
import { extractImages, extractRecordSegments, extractText } from "./gateway/inbound.js";
import { createBatchDispatcher, type BridgeLog } from "./gateway/dispatch.js";

export {
  FACE_NAMES,
  extractImages,
  extractRecordSegments,
  extractText,
  resolveInboundCommandAuthorization,
  summarizeBatch,
} from "./gateway/inbound.js";
export { MessageBatcher } from "./gateway/batch.js";
export { createBatchDispatcher } from "./gateway/dispatch.js";
export type { BridgeLog } from "./gateway/dispatch.js";
export type { BufferedMessage } from "./gateway/batch.js";
export {
  cleanupVoiceFiles,
  convertAmrToMp3,
  convertSilkToMp3,
  downloadVoiceFile,
  ensureVoiceTmpDir,
  isAmrFormat,
  isSilkFormat,
  processVoiceSegments,
} from "./voice.js";

// Reconnect policy: fast retries first, then back off to once a minute.
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];
const MAX_RECONNECT_ATTEMPTS = 100;

// Message batching — aligned with the Telegram text fragment gap.
const BATCH_GAP_MS = 1500;
const BATCH_MAX_MESSAGES = 12;
const BATCH_MAX_CHARS = 50000;

export interface GatewayContext {
  account: ResolvedOneBotAccount;
  abortSignal: AbortSignal;
  cfg: OpenClawConfig;
  onReady?: (data: unknown) => void;
  onError?: (error: Error) => void;
  log?: BridgeLog;
}

export async function startGateway(ctx: GatewayContext): Promise<void> {
  const { account, abortSignal, cfg, onReady, onError, log } = ctx;
  const tag = `[onebot:${account.accountId}]`;

  if (!account.wsUrl) {
    throw new Error("OneBot not configured (missing wsUrl)");
  }

  let reconnectAttempts = 0;
  let isAborted = false;
  let currentWs: WebSocket | null = null;
  let isConnecting = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let batcher: MessageBatcher | null = null;

  abortSignal.addEventListener("abort", () => {
    isAborted = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    batcher?.dispose();
    batcher = null;
    cleanup();
  });

  const cleanup = () => {
    if (
      currentWs &&
      (currentWs.readyState === WebSocket.OPEN || currentWs.readyState === WebSocket.CONNECTING)
    ) {
      currentWs.close();
    }
    currentWs = null;
  };

  const scheduleReconnect = (customDelay?: number) => {
    if (isAborted || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log?.error(`${tag} max reconnect attempts reached or aborted`);
      return;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const delay = customDelay ?? RECONNECT_DELAYS[Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1)];
    reconnectAttempts++;
    log?.info(`${tag} reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!isAborted) void connect();
    }, delay);
  };

  // Per-gateway cache of `group_id:user_id -> is_robot`. One HTTP lookup per
  // member; never re-queries the same member on every message.
  const robotCache = new Map<string, boolean>();
  // Last admitted timestamp per bot user id — a bot is admitted at most once
  // per botMinIntervalSec so two bots can talk without flooding the group.
  const botLastAdmitted = new Map<string, number>();

  /**
   * Group-membership bot check via SnowLuma's `get_group_member_info`
   * (`is_robot` field — reliable for real bots; NTQQ-logged accounts report
   * false, so a false result may still be a bot, but a true result is always
   * a bot). Failures are NOT treated as bot (don't drop a human's message).
   */
  const isRobotMember = async (groupId: string | number, senderId: string): Promise<boolean> => {
    const key = `${groupId}:${senderId}`;
    const cached = robotCache.get(key);
    if (cached !== undefined) return cached;

    try {
      const url = `${account.httpUrl}/get_group_member_info`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (account.accessToken) headers.Authorization = `Bearer ${account.accessToken}`;
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ group_id: Number(groupId), user_id: Number(senderId) }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as {
        data?: { is_robot?: boolean };
      };
      const robot = body.data?.is_robot === true;
      robotCache.set(key, robot);
      return robot;
    } catch {
      // Network/parse failure: do not drop the message on a flaky lookup.
      return false;
    }
  };

  /**
   * Ingest one message: filter, intercept control commands, then buffer.
   * Control commands are handled here (before coalescing) so that
   * "hello\n/silent" can never bury the command inside a batch and leak it to
   * the model as ordinary text.
   */
  const ingest = async (event: OneBotMessageEvent) => {
    const isGroup = event.message_type === "group";
    const senderId = String(event.user_id);
    const senderName = event.sender.card || event.sender.nickname || senderId;
    const peerId = isGroup ? `group:${event.group_id}` : `private:${senderId}`;

    const inbound = checkInboundAllowed(account, peerId);
    if (!inbound.allowed) {
      log?.debug?.(`${tag} ignoring message from unlisted ${peerId}`);
      return;
    }

    if (event.user_id === event.self_id) return;

    // Bot-loop guard: manual ignore list first (fast, no network), then the
    // automatic is_robot check for group members — rate-limited, not dropped:
    // a bot's message is admitted once per botMinIntervalSec, so the agent can
    // still talk to a bot without the two flooding the group.
    if (isIgnoredSender(account, senderId)) {
      log?.info(`${tag} ignoring message from ignored sender ${senderId} (ignoreFrom)`);
      return;
    }
    if (isGroup && account.ignoreBots && (await isRobotMember(event.group_id!, senderId))) {
      const now = Date.now();
      const last = botLastAdmitted.get(senderId) ?? 0;
      if (now - last < account.botMinIntervalSec * 1000) {
        log?.info(
          `${tag} rate-limiting bot member ${senderId} (next admit in ${Math.max(0, Math.ceil((account.botMinIntervalSec * 1000 - (now - last)) / 1000))}s)`,
        );
        return;
      }
      botLastAdmitted.set(senderId, now);
      log?.info(`${tag} admitting bot member ${senderId} (is_robot, rate-limited)`);
    }

    const text = extractText(event.message, { selfId: event.self_id }) || event.raw_message;
    const trimmedText = text.trim();

    if (trimmedText.startsWith("/") && isControlCommand(trimmedText)) {
      const ctrl = handleControlCommand(trimmedText, account, senderId);
      if (ctrl.handled) {
        if (ctrl.reply) {
          void sendOutboundText({ to: peerId, text: ctrl.reply, account })
            .then((r) => {
              if (r?.error) log?.warn?.(`${tag} owner reply blocked: ${r.error}`);
            })
            .catch((err) => log?.error(`${tag} owner reply failed: ${err}`));
        }
        log?.info(`${tag} control command handled (ingest): ${trimmedText.slice(0, 40)}`);
        return;
      }
    }

    // Any OTHER slash command (OpenClaw built-ins like /reset /new /model /think)
    // is only forwarded to the agent when the sender has command rights. An
    // unprivileged group member must never reach the agent with a command —
    // otherwise anyone in a listed group could reset or reconfigure the agent.
    if (trimmedText.startsWith("/") && !isCommandSenderAuthorized(account, senderId)) {
      log?.info(`${tag} dropping command from unprivileged sender ${senderId}: ${trimmedText.slice(0, 40)}`);
      return;
    }

    log?.info(
      `${tag} ${isGroup ? "Group" : "Private"} message from ${senderName}(${senderId}) msg=${event.message_id}: ${text.slice(0, 100)}`,
    );

    if (isGroup && account.groupAutoReact) {
      void reactToMessage(account, event.message_id, account.groupAutoReactEmojiId)
        .then((result) => {
          if (!result.ok) {
            log?.error(
              `${tag} auto reaction failed for group:${event.group_id} msg=${event.message_id}: ${result.error ?? "unknown error"}`,
            );
          }
        })
        .catch((err) => {
          log?.error(
            `${tag} auto reaction error for group:${event.group_id} msg=${event.message_id}: ${String(err)}`,
          );
        });
    }

    const buffered: BufferedMessage = {
      event,
      text,
      images: extractImages(event.message),
      recordSegments: extractRecordSegments(event.message),
    };

    // Groups are batched per sender so two people talking at once never merge
    // into a single agent turn.
    const batchKey = isGroup ? `group:${event.group_id}::${senderId}` : `private:${senderId}`;
    batcher?.push(batchKey, buffered);
  };

  const connect = async () => {
    if (isConnecting) {
      log?.debug?.(`${tag} already connecting, skip`);
      return;
    }
    isConnecting = true;

    try {
      cleanup();

      const pluginRuntime = getOneBotRuntime();
      batcher?.dispose();
      batcher = new MessageBatcher({
        gapMs: BATCH_GAP_MS,
        maxMessages: BATCH_MAX_MESSAGES,
        maxChars: BATCH_MAX_CHARS,
        onFlush: createBatchDispatcher({ account, cfg, pluginRuntime, log }),
        onError: (err) => log?.error(`${tag} batch dispatch error: ${err}`),
      });

      const wsOptions: WebSocket.ClientOptions = {
        // Cap the frame size: a peer cannot exhaust memory with one message.
        maxPayload: 16 * 1024 * 1024,
        // Compression is a CPU/DoS amplifier on a trusted local socket.
        perMessageDeflate: false,
        ...(account.accessToken
          ? { headers: { Authorization: `Bearer ${account.accessToken}` } }
          : {}),
      };

      log?.info(`${tag} connecting to ${account.wsUrl}`);
      const ws = new WebSocket(account.wsUrl, wsOptions);
      currentWs = ws;

      ws.on("open", () => {
        log?.info(`${tag} websocket connected`);
        isConnecting = false;
        reconnectAttempts = 0;
        onReady?.({});
      });

      ws.on("message", (data) => {
        try {
          const event = JSON.parse(data.toString()) as OneBotEvent;
          log?.debug?.(`${tag} event: post_type=${event.post_type}`);

          switch (event.post_type) {
            case "message":
              void ingest(event as OneBotMessageEvent);
              break;
            case "meta_event":
              if (event.meta_event_type === "lifecycle" && event.sub_type === "connect") {
                log?.info(`${tag} lifecycle: connected`);
              }
              break;
            case "notice":
              log?.debug?.(`${tag} notice: ${(event as { notice_type?: string }).notice_type}`);
              break;
          }
        } catch (err) {
          log?.error(`${tag} message parse error: ${err}`);
        }
      });

      ws.on("close", (code, reason) => {
        log?.info(`${tag} websocket closed: ${code} ${reason.toString()}`);
        isConnecting = false;
        cleanup();
        if (!isAborted && code !== 1000) scheduleReconnect();
      });

      ws.on("error", (err) => {
        log?.error(`${tag} websocket error: ${err.message}`);
        isConnecting = false;
        onError?.(err);
      });
    } catch (err) {
      isConnecting = false;
      log?.error(`${tag} connection failed: ${err}`);
      scheduleReconnect();
    }
  };

  await connect();

  return new Promise((resolve) => {
    abortSignal.addEventListener("abort", () => resolve());
  });
}
