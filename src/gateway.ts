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
import { checkInboundAllowed, isControlCommand } from "./policy.js";
import { handleControlCommand } from "./owner-control.js";
import { MessageBatcher, type BufferedMessage } from "./gateway/batch.js";
import { extractImages, extractRecordSegments, extractText } from "./gateway/inbound.js";
import { createBatchDispatcher, type BridgeLog } from "./gateway/dispatch.js";

export {
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

  /**
   * Ingest one message: filter, intercept control commands, then buffer.
   * Control commands are handled here (before coalescing) so that
   * "hello\n/silent" can never bury the command inside a batch and leak it to
   * the model as ordinary text.
   */
  const ingest = (event: OneBotMessageEvent) => {
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

    const text = extractText(event.message) || event.raw_message;
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
              ingest(event as OneBotMessageEvent);
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
