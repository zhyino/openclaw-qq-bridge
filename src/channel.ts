import { basename, extname, isAbsolute, join, resolve as resolvePath } from "node:path";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import type { ResolvedOneBotAccount } from "./types.js";
import { getDefaultContainerSharedDir, getDefaultSharedDir } from "./env.js";
import { fileUriToPath } from "./paths.js";
import {
  listOneBotAccountIds,
  resolveOneBotAccount,
  applyOneBotAccountConfig,
  validateOneBotConfig,
} from "./config.js";
import { reactToMessage, sendImage, sendRecord, sendText, uploadFile } from "./outbound.js";
import { buildQzoneAndProfileTools } from "./qzone-tools.js";
import { startGateway } from "./gateway.js";
import { assertOutboundAllowed } from "./policy.js";
import { parseTarget } from "./target.js";

const DEFAULT_ACCOUNT_ID = "default";
const ONEBOT_MESSAGE_ACTIONS = ["react"] as const;
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".heif"]);
const AUDIO_EXTS = new Set([".mp3", ".ogg", ".wav", ".m4a", ".aac", ".flac", ".amr", ".silk", ".opus"]);

function createActionResult<TDetails>(text: string, details: TDetails) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function resolveLocalMediaPath(mediaUrl: string): string {
  if (!mediaUrl || !mediaUrl.trim()) {
    throw new Error("OneBot sendMedia requires mediaUrl");
  }
  if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
    throw new Error("OneBot sendMedia currently supports local file paths only");
  }
  if (mediaUrl.startsWith("file://")) {
    return fileUriToPath(mediaUrl);
  }
  return isAbsolute(mediaUrl) ? mediaUrl : resolvePath(mediaUrl);
}

export const onebotPlugin: ChannelPlugin<ResolvedOneBotAccount> = {
  id: "onebot",
  meta: {
    id: "onebot",
    label: "OneBot",
    selectionLabel: "OneBot (QQ via NapCat)",
    docsPath: "/docs/channels/onebot",
    blurb: "Connect to QQ via OneBot 11 protocol (NapCat/go-cqhttp)",
    order: 55,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    threads: false,
    blockStreaming: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: {
      minChars: 80,
      idleMs: 600,
    },
  },
  reload: { configPrefixes: ["channels.onebot"] },
  messaging: {
    normalizeTarget: (target) => {
      return target.replace(/^onebot:/i, "");
    },
    targetResolver: {
      looksLikeId: (id) => {
        const normalized = id.replace(/^onebot:/i, "");
        if (normalized.startsWith("private:")) return /^private:\d+$/.test(normalized);
        if (normalized.startsWith("group:")) return /^group:\d+$/.test(normalized);
        return /^\d+$/.test(normalized);
      },
      hint: "private:<user_id> or group:<group_id>",
    },
  },
  config: {
    listAccountIds: (cfg) => listOneBotAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveOneBotAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => Boolean(account?.wsUrl && account?.httpUrl),
    describeAccount: (account) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(account?.wsUrl && account?.httpUrl),
    }),
  },
  setup: {
    validateInput: ({ input }) => {
      if (!input.token && !input.useEnv) {
        return "OneBot requires --token (format: wsUrl,httpUrl[,accessToken[,sharedDir[,containerSharedDir]]]) or --use-env (ONEBOT_WS_URL, ONEBOT_HTTP_URL)";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      let wsUrl = "";
      let httpUrl = "";
      let accessToken: string | undefined;
      const raw = input as Record<string, unknown>;
      let sharedDir = typeof raw.sharedDir === "string" && raw.sharedDir.trim()
        ? raw.sharedDir.trim()
        : undefined;
      let containerSharedDir = typeof raw.containerSharedDir === "string" && raw.containerSharedDir.trim()
        ? raw.containerSharedDir.trim()
        : undefined;

      if (input.token) {
        const parts = input.token.split(",");
        wsUrl = parts[0]?.trim() ?? "";
        httpUrl = parts[1]?.trim() ?? "";
        accessToken = parts[2]?.trim() || undefined;
        sharedDir ??= parts[3]?.trim() || undefined;
        containerSharedDir ??= parts[4]?.trim() || undefined;
      }

      if (!input.useEnv) {
        sharedDir ??= getDefaultSharedDir();
        containerSharedDir ??= getDefaultContainerSharedDir();
      }

      return applyOneBotAccountConfig(cfg, accountId, {
        wsUrl,
        httpUrl,
        accessToken,
        sharedDir,
        containerSharedDir,
        name: input.name,
      });
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4500,
    sendText: async ({ to, text, accountId, replyToId, cfg }) => {
      const account = resolveOneBotAccount(cfg, accountId);
      const result = await sendText({ to, text, accountId, replyToId, account });
      if (result.error) {
        throw new Error(result.error);
      }
      // A deliberate silent drop (muted notice / rate limit) is not a failure.
      // Returning without a messageId used to make the host report a delivery
      // error; synthesise an id so "nothing sent on purpose" stays silent.
      if (result.suppressed) {
        return { channel: "onebot", messageId: `suppressed:${result.suppressed}` };
      }
      if (!result.messageId) {
        throw new Error("OneBot sendText did not return a messageId");
      }
      return {
        channel: "onebot",
        messageId: result.messageId,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) => {
      const account = resolveOneBotAccount(cfg, accountId);
      const target = parseTarget(to);

      // ── QQ Bridge H1 fix: unified outbound gate on the media path too ──
      const gate = assertOutboundAllowed(account, to, text ?? "");
      if (!gate.allowed) {
        throw new Error(`media send blocked by policy: ${gate.reason ?? "not allowed"}`);
      }
      // Path whitelist is enforced at the single choke point
      // (resolveNapCatMediaUri in outbound.ts); no duplicate check here.
      const mediaPath = resolveLocalMediaPath(mediaUrl ?? "");
      const ext = extname(mediaPath).toLowerCase();

      let mediaResult;
      if (AUDIO_EXTS.has(ext)) {
        mediaResult = await sendRecord(account, target.type, target.id, mediaPath);
      } else if (IMAGE_EXTS.has(ext)) {
        mediaResult = await sendImage(account, target.type, target.id, mediaPath);
      } else {
        mediaResult = await uploadFile(account, target.type, target.id, mediaPath, basename(mediaPath));
      }

      let textMessageId: string | undefined;
      if ((text ?? "").trim()) {
        const textResult = await sendText({ to, text, accountId, account });
        if (textResult.error) {
          throw new Error(textResult.error);
        }
        textMessageId = textResult.messageId;
      }

      const mediaMessageId =
        mediaResult?.data && typeof mediaResult.data === "object" && "message_id" in mediaResult.data
          ? String(mediaResult.data.message_id)
          : undefined;

      return {
        channel: "onebot",
        messageId: mediaMessageId ?? textMessageId ?? `${Date.now()}`,
      };
    },
  },
  actions: {
    describeMessageTool: ({ cfg }) => {
      const account = resolveOneBotAccount(cfg);
      if (!account.enabled || !account.wsUrl || !account.httpUrl) {
        return null;
      }
      return {
        actions: [...ONEBOT_MESSAGE_ACTIONS],
      };
    },
    supportsAction: ({ action }) => action === "react",
    handleAction: async ({ action, cfg, params, accountId, toolContext }) => {
      if (action !== "react") {
        return createActionResult(`Unsupported OneBot action: ${action}`, {
          ok: false,
          channel: "onebot",
          action,
          error: `Unsupported OneBot action: ${action}`,
        });
      }

      const messageId =
        params.message_id ??
        params.messageId ??
        params.message ??
        toolContext?.currentMessageId;
      const emojiId =
        params.emoji_id ??
        params.emojiId ??
        params.emoji ??
        params.reaction;

      if (messageId == null || emojiId == null || String(emojiId).trim() === "") {
        return createActionResult(
          "OneBot react requires `emoji` and `message_id` (or current message context).",
          {
            ok: false,
            channel: "onebot",
            action,
            error: "OneBot react requires `emoji` and `message_id` (or current message context).",
          },
        );
      }

      const account = resolveOneBotAccount(cfg, accountId);
      const result = await reactToMessage(account, messageId as string | number, emojiId as string | number);

      if (!result.ok) {
        return createActionResult(result.error ?? "OneBot reaction failed", {
          ok: false,
          channel: "onebot",
          action,
          error: result.error ?? "OneBot reaction failed",
          data: result,
        });
      }

      return createActionResult(`Reacted with ${String(emojiId)} to message ${String(messageId)}.`, {
        ok: true,
        channel: "onebot",
        action,
        data: result,
      });
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const { account, abortSignal, log, cfg } = ctx;

      log?.info(`[onebot:${account.accountId}] Starting gateway`);

      // Startup check-up: the permissive defaults (empty allowFrom /
      // outboundAllow) stay for upgraders, but they are never silent again.
      for (const issue of validateOneBotConfig(account)) {
        const line = `[onebot:${account.accountId}] config ${issue.level}: ${issue.field} — ${issue.message}`;
        if (issue.level === "error") {
          log?.error(line);
        } else if (log?.warn) {
          log.warn(line);
        } else {
          log?.info(line);
        }
      }

      await startGateway({
        account,
        abortSignal,
        cfg,
        log,
        onReady: () => {
          log?.info(`[onebot:${account.accountId}] Gateway ready`);
          ctx.setStatus({
            ...ctx.getStatus(),
            running: true,
            connected: true,
            lastConnectedAt: Date.now(),
          });
        },
        onError: (error) => {
          log?.error(`[onebot:${account.accountId}] Gateway error: ${error.message}`);
          ctx.setStatus({
            ...ctx.getStatus(),
            lastError: error.message,
          });
        },
      });
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(account?.wsUrl && account?.httpUrl),
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },
  agentTools: ({ cfg }) => {
    if (!cfg) {
      return [];
    }
    const account = resolveOneBotAccount(cfg);
    if (!account.enabled || !account.httpUrl) {
      return [];
    }
    return buildQzoneAndProfileTools(account);
  },
};
