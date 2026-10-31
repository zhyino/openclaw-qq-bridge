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
  OneBotNoticeEvent,
} from "./types.js";
import { getOneBotRuntime } from "./runtime.js";
import { reactToMessage, sendText as sendOutboundText } from "./outbound.js";
import { checkInboundAllowed, isCommandSenderAuthorized, isControlCommand, isIgnoredSender } from "./policy.js";
import { handleControlCommand } from "./owner-control.js";
import { MessageBatcher, type BufferedMessage } from "./gateway/batch.js";
import { extractImages, extractRecordSegments, extractText, stripStructuralPrefixes } from "./gateway/inbound.js";
import { createBatchDispatcher, type BridgeLog } from "./gateway/dispatch.js";
import { WakeDigest, isWakeMention, resolveWakePolicy } from "./wake.js";

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
  const wakeDigest = new WakeDigest();

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

    // Manual ignore list (fast, no network). Automatic bot rate-limiting
    // happens on OUTBOUND (see outbound.ts) so bot messages still reach the
    // agent with full context — we only throttle how often we reply.
    if (isIgnoredSender(account, senderId)) {
      log?.info(`${tag} ignoring message from ignored sender ${senderId} (ignoreFrom)`);
      return;
    }

    const text = extractText(event.message, { selfId: event.self_id }) || event.raw_message;
    const trimmedText = text.trim();
    // Command detection must ignore structural prefixes that extractText adds
    // for @-mentions. Otherwise "@bot /reset" becomes "[被@] /reset", fails
    // startsWith("/") and slips past the privilege gate as plain chat text.
    const commandText = stripStructuralPrefixes(trimmedText);

    if (commandText.startsWith("/") && isControlCommand(commandText)) {
      const ctrl = handleControlCommand(commandText, account, senderId);
      if (ctrl.handled) {
        if (ctrl.reply) {
          void sendOutboundText({ to: peerId, text: ctrl.reply, account })
            .then((r) => {
              if (r?.error) log?.warn?.(`${tag} owner reply blocked: ${r.error}`);
            })
            .catch((err) => log?.error(`${tag} owner reply failed: ${err}`));
        }
        log?.info(`${tag} control command handled (ingest): ${commandText.slice(0, 40)}`);
        return;
      }
    }

    // Any OTHER slash command (OpenClaw built-ins like /reset /new /model /think)
    // is only forwarded to the agent when the sender has command rights. An
    // unprivileged group member must never reach the agent with a command —
    // otherwise anyone in a listed group could reset or reconfigure the agent.
    if (commandText.startsWith("/") && !isCommandSenderAuthorized(account, senderId)) {
      log?.info(`${tag} dropping command from unprivileged sender ${senderId}: ${commandText.slice(0, 40)}`);
      return;
    }

    log?.info(
      `${tag} ${isGroup ? "Group" : "Private"} message from ${senderName}(${senderId}) msg=${event.message_id}: ${text.slice(0, 100)}`,
    );

    // Per-group wake policy (groups.<id>.wakePolicy / requireMention, or the
    // account default). Non-woken messages are recorded and folded into the
    // next wake as a short digest — zero model calls while not addressed.
    let bodyText = text;
    if (isGroup) {
      const { policy, probability } = resolveWakePolicy(account, event.group_id!);
      if (policy === "all") {
        wakeDigest.clear(peerId);
      } else {
        const mentioned = isWakeMention({
          text,
          nickname: account.name,
          isPoke: event.sub_type === "poke",
        });
        const woken = mentioned || (policy === "sampled" && Math.random() < probability);
        if (!woken) {
          wakeDigest.record(peerId, `${senderName}: ${trimmedText}`);
          log?.info(
            `${tag} group ${event.group_id} wake=${policy}: recorded without waking (${wakeDigest.size(peerId)} buffered)`,
          );
          return;
        }
        const digest = wakeDigest.take(peerId);
        if (digest) bodyText = `${digest}\n${text}`;
      }
    }

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
      text: bodyText,
      images: extractImages(event.message),
      recordSegments: extractRecordSegments(event.message),
    };

    // Groups are batched per sender so two people talking at once never merge
    // into a single agent turn.
    const batchKey = isGroup ? `group:${event.group_id}::${senderId}` : `private:${senderId}`;
    batcher?.push(batchKey, buffered);
  };

  /**
   * Handle OneBot notice events. Today that means QQ "poke" (戳一戳): when
   * someone pokes the bot we synthesise an inbound message and run it through
   * the same ingest path (whitelist, ignoreFrom, batching, identity) so the
   * agent can react naturally. Everything else is ignored.
   */
  const handleNotice = (notice: OneBotNoticeEvent) => {
    if (!account.pokeReply) return;
    if (notice.notice_type !== "notify" || notice.sub_type !== "poke") return;
    const selfId = Number(notice.self_id);
    const targetId = Number(notice.target_id);
    const userId = Number(notice.user_id);
    // Only a poke aimed at this bot matters; ignore pokes between other members.
    if (!selfId || !targetId || selfId !== targetId) return;
    if (!userId) return;

    const groupId = notice.group_id != null ? Number(notice.group_id) : undefined;
    const pokeEvent: OneBotMessageEvent = {
      post_type: "message",
      message_type: groupId ? "group" : "private",
      sub_type: "poke",
      // Synthesised id: unique enough for batching/threading, not a real QQ id.
      message_id: Math.abs(Date.now() ^ Math.trunc(Math.random() * 1e9)) || 1,
      user_id: userId,
      group_id: groupId,
      message: [{ type: "text", data: { text: "[戳一戳]" } }],
      raw_message: "[戳一戳]",
      sender: { user_id: userId, nickname: String(userId) },
      self_id: selfId,
      time: notice.time ?? Math.trunc(Date.now() / 1000),
    };
    log?.info?.(
      `${tag} poke from ${userId}${groupId ? ` in group ${groupId}` : ""} -> inbound`,
    );
    void ingest(pokeEvent);
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
              void handleNotice(event as OneBotNoticeEvent);
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
