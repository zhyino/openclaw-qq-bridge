import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ResolvedOneBotAccount } from "../types.js";
import { isSilent } from "../owner-control.js";
import { redactSensitive } from "../policy.js";
import { sendImage, sendRecord, sendText as sendOutboundText } from "../outbound.js";
import { bumpSessionGeneration } from "../session-generation.js";
import type { RecallTracker } from "../recall.js";
import { cleanupVoiceFiles, processVoiceSegments } from "../voice.js";
import type { BufferedMessage } from "./batch.js";
import {
  buildAttachmentInfo,
  buildInboundContext,
  summarizeBatch,
  type OneBotRuntime,
  type VoiceMedia,
} from "./inbound.js";

/**
 * The host refuses to run new work in an archived session. dispatchBatch
 * catches this, rotates the per-peer session generation and retries once —
 * archiving a conversation then simply starts a fresh one on the next message.
 */
export class SessionArchivedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionArchivedError";
  }
}

export interface BridgeLog {
  info: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface DispatchDeps {
  account: ResolvedOneBotAccount;
  cfg: OpenClawConfig;
  pluginRuntime: OneBotRuntime;
  log?: BridgeLog;
  /** Tracks recalled message ids so a recalled message is never answered. */
  recalls?: RecallTracker;
}

const RESPONSE_TIMEOUT_MS = 90_000;
const AUDIO_EXTS = new Set([".mp3", ".ogg", ".wav", ".m4a", ".flac", ".aac", ".opus", ".amr", ".silk"]);
const MEDIA_EXT_RE = /.*(\.[^.]+)$/;

function extOf(mediaPath: string): string {
  return mediaPath.toLowerCase().replace(MEDIA_EXT_RE, "$1");
}

/**
 * Turns one coalesced batch into one agent turn and delivers the reply.
 *
 * Every dependency arrives through `deps` — this used to be a 250-line closure
 * nested three levels deep inside `connect()`, which made it impossible to test
 * a delivery failure without standing up a WebSocket.
 */
export function createBatchDispatcher(deps: DispatchDeps) {
  const { account, cfg, pluginRuntime, log, recalls } = deps;
  const tag = `[onebot:${account.accountId}]`;

  return async function dispatchBatch(_batchKey: string, messages: BufferedMessage[]): Promise<void> {
    if (messages.length === 0) return;

    // Optional natural reply delay: waits before the agent turn starts, so a
    // quick follow-up message is more likely to join this batch and the reply
    // does not feel machine-fast. replyDelaySec is the BASE; the actual delay
    // is a random 0.5x-1.5x jitter of it, so consecutive replies never have
    // the exact same cadence. Configurable per account via replyDelaySec.
    // It also gives a recall notice time to arrive before we spend a turn.
    if (account.replyDelaySec > 0) {
      const baseMs = account.replyDelaySec * 1000;
      const delayMs = Math.round(baseMs * (0.5 + Math.random()));
      log?.info(`${tag} reply delay ${(delayMs / 1000).toFixed(1)}s before dispatching batch`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    // Drop recalled messages: replying to something the user withdrew is a bug.
    const live = recalls ? messages.filter((m) => !recalls.isRecalled(m.event.message_id)) : messages;
    if (live.length === 0) {
      log?.info(`${tag} batch fully recalled (${messages.length} message(s)) — skipping turn`);
      return;
    }
    if (live.length < messages.length) {
      log?.info(`${tag} dropped ${messages.length - live.length} recalled message(s) from batch`);
    }

    const summary = summarizeBatch(live);
    const { isGroup, senderId, senderName, address } = summary;

    if (live.length > 1) {
      log?.info(`${tag} Batched ${live.length} messages from ${senderName}: ${summary.combinedText.slice(0, 100)}`);
    }

    pluginRuntime.channel.activity.record({
      channel: "onebot",
      accountId: account.accountId,
      direction: "inbound",
    });

    // Silent mode mutes groups only: owner DMs must still reach the agent,
    // otherwise there is no way to switch it back on from chat.
    if (isSilent() && isGroup) {
      log?.info(`${tag} silent mode: dropped group message from ${senderName}`);
      return;
    }

    const voiceMedia: VoiceMedia[] = await processVoiceSegments(summary.combinedRecordSegments, log);
    const voiceFilePaths = voiceMedia.map((v) => v.path);
    const attachmentInfo = buildAttachmentInfo(
      summary.combinedImages,
      voiceMedia,
      summary.combinedRecordSegments.length,
    );

    const buildCtx = () =>
      buildInboundContext({
        pluginRuntime,
        cfg,
        summary,
        accountId: account.accountId,
        accountAllowFrom: account.allowFrom,
        account,
        body: summary.combinedText + attachmentInfo,
        voiceMedia,
      });

    try {
      const first = buildCtx();

      log?.info(
        `${tag} ctxPayload: From=${address}, SessionKey=${first.ctxPayload.SessionKey}, ChatType=${isGroup ? "group" : "direct"}, hasAudio=${voiceMedia.length > 0}`,
      );

      try {
        await runTurn(first.ctxPayload, summary, first.agentId);
      } catch (err) {
        if (!(err instanceof SessionArchivedError)) throw err;
        // The user archived this conversation: bump the generation and retry
        // once against a brand-new session instead of failing forever.
        const generation = bumpSessionGeneration(summary.peerId);
        log?.warn?.(
          `${tag} session archived; rotating ${summary.peerId} to generation ${generation} and retrying`,
        );
        const retry = buildCtx();
        log?.info(`${tag} retry ctxPayload: SessionKey=${retry.ctxPayload.SessionKey}`);
        await runTurn(retry.ctxPayload, summary, retry.agentId);
      }
    } finally {
      cleanupVoiceFiles(voiceFilePaths);
    }
  };

  async function runTurn(
    ctxPayload: Record<string, unknown>,
    summary: ReturnType<typeof summarizeBatch>,
    agentId: string,
  ): Promise<void> {
    const { isGroup, event, address } = summary;
    let archivedDetected = false;
    const isArchivedError = (err: unknown) =>
      /is archived/i.test(err instanceof Error ? err.message : String(err));

    const sendErrorText = async (raw: string) => {
      // Redact rather than drop: blocking the error message leaves the user
      // with silence AND no diagnostic, which is strictly worse.
      // bypassMute: these are OUR diagnostics, not host-injected notices — a
      // muteSystemNotices default must not swallow them.
      // exemptRateLimit: a diagnostic the user needs must not be throttled away.
      const text = redactSensitive(raw).slice(0, 300);
      try {
        const result = await sendOutboundText({
          to: address,
          text,
          account,
          bypassMute: true,
          exemptRateLimit: true,
        });
        if (result?.error) {
          log?.warn?.(`${tag} error notice blocked/failed: ${result.error}`);
        }
      } catch (err) {
        log?.error(`${tag} failed to send error notice: ${err}`);
      }
    };

    const deliverMedia = async (mediaPaths: string[]): Promise<boolean> => {
      let audioSendFailed = false;
      const targetType = isGroup ? ("group" as const) : ("private" as const);
      const targetId = isGroup ? event.group_id! : event.user_id;

      for (const mediaPath of mediaPaths) {
        const isAudio = AUDIO_EXTS.has(extOf(mediaPath));
        try {
          const result = isAudio
            ? await sendRecord(account, targetType, targetId, mediaPath)
            : await sendImage(account, targetType, targetId, mediaPath);
          const messageId = (result.data as { message_id?: number } | null)?.message_id;
          log?.info(`${tag} Sent ${isAudio ? "voice" : "media"}: ${mediaPath}${messageId != null ? ` message_id=${messageId}` : ""}`);
        } catch (err) {
          if (isAudio) audioSendFailed = true;
          log?.error(`${tag} media send failed (${mediaPath}): ${err}`);
        }
      }
      return audioSendFailed;
    };

    try {
      const messagesConfig = pluginRuntime.channel.reply.resolveEffectiveMessagesConfig(cfg, agentId);

      let hasResponse = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => {
          if (!hasResponse) reject(new Error("Response timeout"));
        }, RESPONSE_TIMEOUT_MS);
      });

      const dispatchPromise = pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          responsePrefix: messagesConfig.responsePrefix,
          deliver: async (
            payload: {
              text?: string;
              mediaUrls?: string[];
              mediaUrl?: string;
              replyToId?: string | number | null;
            },
            info: { kind: string },
          ) => {
            hasResponse = true;
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }

            // Every message in this batch was recalled while the turn ran:
            // stay silent instead of answering a withdrawn message.
            if (recalls?.allRecalled(summary.messageIds)) {
              log?.info(`${tag} reply suppressed: all ${summary.messageIds.length} message(s) were recalled`);
              return;
            }

            log?.info(`${tag} deliver(${info.kind}): textLen=${payload.text?.length ?? 0}`);

            const mediaPaths: string[] = [];
            if (payload.mediaUrls?.length) mediaPaths.push(...payload.mediaUrls);
            if (payload.mediaUrl && !mediaPaths.includes(payload.mediaUrl)) {
              mediaPaths.push(payload.mediaUrl);
            }

            const audioSendFailed = await deliverMedia(mediaPaths);

            let replyText = payload.text ?? "";
            if (audioSendFailed && !replyText.trim()) {
              replyText = "[OpenClaw] 语音回复发送失败，已切换为文本提醒。";
            }
            if (!replyText.trim()) return;

            try {
              const sendResult = await sendOutboundText({
                to: address,
                text: replyText,
                replyToId:
                  payload.replyToId != null ? String(payload.replyToId) : null,
                // "Must answer when @-ed": an inbound @-mention (or @all) exempts
                // this reply from the outbound rate limit. Host-implicit
                // replyToId does NOT count — every reply carries one by default.
                exemptRateLimit:
                  summary.combinedText.includes("[被@]") ||
                  summary.combinedText.includes("[被@全体]"),
                account,
              });
              if (sendResult?.error) {
                log?.warn?.(`${tag} send to ${address} blocked/failed: ${sendResult.error}`);
                return;
              }
              pluginRuntime.channel.activity.record({
                channel: "onebot",
                accountId: account.accountId,
                direction: "outbound",
              });
            } catch (err) {
              log?.error(`${tag} send failed: ${err}`);
            }
          },
          onError: async (err: unknown) => {
            if (isArchivedError(err)) {
              // Not a user-visible failure: the session was archived. Mark it so
              // dispatchBatch rotates to a fresh generation and retries.
              archivedDetected = true;
              hasResponse = true;
              if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
              }
              return;
            }
            log?.error(`${tag} dispatch error: ${err}`);
            hasResponse = true;
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }
            await sendErrorText(`[OpenClaw] Error: ${String(err).slice(0, 500)}`);
          },
        },
        replyOptions: {},
      });

      try {
        await Promise.race([dispatchPromise, timeoutPromise]);
      } catch (err) {
        if (timeoutId) clearTimeout(timeoutId);
        if (archivedDetected || isArchivedError(err)) {
          throw new SessionArchivedError(String(err instanceof Error ? err.message : err));
        }
        if (!hasResponse) {
          // Log only: a "processing..." placeholder in the chat is noise, and
          // the user already knows they sent a message. Real failures below
          // still reach them.
          log?.error(`${tag} no response within timeout (no placeholder sent)`);
        }
      }
    } catch (err) {
      // Let dispatchBatch rotate the session generation instead of reporting a
      // failure the user cannot act on.
      if (err instanceof SessionArchivedError) throw err;
      log?.error(`${tag} message processing failed: ${err}`);
      await sendErrorText(`[OpenClaw] Processing failed: ${String(err).slice(0, 500)}`);
    }
  }
}
