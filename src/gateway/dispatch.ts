import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ResolvedOneBotAccount } from "../types.js";
import { isSilent } from "../owner-control.js";
import { redactSensitive } from "../policy.js";
import { sendImage, sendRecord, sendText as sendOutboundText } from "../outbound.js";
import { cleanupVoiceFiles, processVoiceSegments } from "../voice.js";
import type { BufferedMessage } from "./batch.js";
import {
  buildAttachmentInfo,
  buildInboundContext,
  summarizeBatch,
  type OneBotRuntime,
  type VoiceMedia,
} from "./inbound.js";

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
  const { account, cfg, pluginRuntime, log } = deps;
  const tag = `[onebot:${account.accountId}]`;

  return async function dispatchBatch(_batchKey: string, messages: BufferedMessage[]): Promise<void> {
    if (messages.length === 0) return;

    const summary = summarizeBatch(messages);
    const { isGroup, senderId, senderName, address } = summary;

    if (messages.length > 1) {
      log?.info(`${tag} Batched ${messages.length} messages from ${senderName}: ${summary.combinedText.slice(0, 100)}`);
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

    try {
      const { ctxPayload, agentId } = buildInboundContext({
        pluginRuntime,
        cfg,
        summary,
        accountId: account.accountId,
        accountAllowFrom: account.allowFrom,
        body: summary.combinedText + attachmentInfo,
        voiceMedia,
      });

      log?.info(
        `${tag} ctxPayload: From=${address}, SessionKey=${ctxPayload.SessionKey}, ChatType=${isGroup ? "group" : "direct"}, hasAudio=${voiceMedia.length > 0}`,
      );

      await runTurn(ctxPayload, summary, agentId);
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

    const sendErrorText = async (raw: string) => {
      // Redact rather than drop: blocking the error message leaves the user
      // with silence AND no diagnostic, which is strictly worse.
      const text = redactSensitive(raw).slice(0, 300);
      try {
        const result = await sendOutboundText({ to: address, text, account });
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
            payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string },
            info: { kind: string },
          ) => {
            hasResponse = true;
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = null;
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
              const sendResult = await sendOutboundText({ to: address, text: replyText, account });
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
      } catch {
        if (timeoutId) clearTimeout(timeoutId);
        if (!hasResponse) {
          log?.error(`${tag} no response within timeout`);
          await sendErrorText("[OpenClaw] Request received, processing...");
        }
      }
    } catch (err) {
      log?.error(`${tag} message processing failed: ${err}`);
      await sendErrorText(`[OpenClaw] Processing failed: ${String(err).slice(0, 500)}`);
    }
  }
}
