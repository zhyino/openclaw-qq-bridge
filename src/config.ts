import { existsSync } from "node:fs";
import type { ResolvedOneBotAccount, OneBotAccountConfig } from "./types.js";

const DEFAULT_ACCOUNT_ID = "default";

interface OpenClawConfig {
  channels?: {
    onebot?: OneBotChannelConfig;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface OneBotChannelConfig extends OneBotAccountConfig {
  accounts?: Record<string, OneBotAccountConfig>;
}

/**
 * The default account is the channel-level object minus the `accounts` bag.
 *
 * v0.2.x rebuilt this object field by field, which meant every new config key
 * was silently dropped for the (most common) single-account setup until
 * somebody remembered to add it to the list — `mediaAllowDirs` was the one
 * that finally bit. Spreading the whole object makes "forgot to add the field"
 * a non-bug: named and default accounts now resolve identically.
 */
function defaultAccountConfig(onebot: OneBotChannelConfig | undefined): OneBotAccountConfig {
  if (!onebot) return {};
  const { accounts: _accounts, ...channelLevel } = onebot;
  return channelLevel;
}

function normalizeLegacyGroupAllowFrom(groupAllowFrom: string[] | undefined): string[] | undefined {
  if (!Array.isArray(groupAllowFrom) || groupAllowFrom.length === 0) {
    return undefined;
  }

  return groupAllowFrom.map((pattern) => {
    const trimmed = String(pattern).trim();
    if (trimmed === "*" || trimmed.includes(":")) {
      return trimmed;
    }
    return `group:${trimmed}`;
  });
}

function resolveAllowFrom(accountConfig: OneBotAccountConfig): string[] | undefined {
  if (Array.isArray(accountConfig.allowFrom) && accountConfig.allowFrom.length > 0) {
    return accountConfig.allowFrom;
  }
  return normalizeLegacyGroupAllowFrom(accountConfig.groupAllowFrom) ?? accountConfig.allowFrom;
}

/**
 * List all configured OneBot account IDs.
 */
export function listOneBotAccountIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>();
  const onebot = cfg.channels?.onebot;

  if (onebot?.wsUrl || onebot?.httpUrl) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  if (onebot?.accounts) {
    for (const accountId of Object.keys(onebot.accounts)) {
      const acct = onebot.accounts[accountId];
      if (acct?.wsUrl || acct?.httpUrl) {
        ids.add(accountId);
      }
    }
  }

  return Array.from(ids);
}

/**
 * Resolve a OneBot account from config. Pure: no env mutation, no I/O.
 */
export function resolveOneBotAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedOneBotAccount {
  const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
  const onebot = cfg.channels?.onebot;

  const isDefault = resolvedAccountId === DEFAULT_ACCOUNT_ID;
  const accountConfig: OneBotAccountConfig = isDefault
    ? defaultAccountConfig(onebot)
    : (onebot?.accounts?.[resolvedAccountId] ?? {});

  // Environment variable fallbacks for the default account only.
  let wsUrl = accountConfig.wsUrl ?? "";
  let httpUrl = accountConfig.httpUrl ?? "";
  let accessToken = accountConfig.accessToken;

  if (isDefault) {
    if (!wsUrl && process.env.ONEBOT_WS_URL) wsUrl = process.env.ONEBOT_WS_URL;
    if (!httpUrl && process.env.ONEBOT_HTTP_URL) httpUrl = process.env.ONEBOT_HTTP_URL;
    if (!accessToken && process.env.ONEBOT_ACCESS_TOKEN) accessToken = process.env.ONEBOT_ACCESS_TOKEN;
  }

  const allowFrom = resolveAllowFrom(accountConfig);
  const replyAudit = accountConfig.replyAudit !== false;

  return {
    accountId: resolvedAccountId,
    name: accountConfig.name,
    enabled: accountConfig.enabled !== false,
    wsUrl,
    httpUrl,
    accessToken,
    allowFrom,
    groupAutoReact: accountConfig.groupAutoReact === true,
    groupAutoReactEmojiId: accountConfig.groupAutoReactEmojiId ?? 1,
    ownerQQ: accountConfig.ownerQQ,
    outboundAllow: accountConfig.outboundAllow,
    outboundDeny: accountConfig.outboundDeny,
    replyAudit,
    sharedDir: accountConfig.sharedDir,
    mediaAllowDirs: accountConfig.mediaAllowDirs,
    qzoneWrite: accountConfig.qzoneWrite === true,
    muteSystemNotices: accountConfig.muteSystemNotices !== false,
    ignoreFrom: accountConfig.ignoreFrom,
    userLabels: accountConfig.userLabels,
    outboundRateLimit: accountConfig.outboundRateLimit ?? 0,
    replyDelaySec: accountConfig.replyDelaySec ?? 0,
    pokeReply: accountConfig.pokeReply !== false,
    config: accountConfig,
  };
}

/**
 * Apply account configuration changes.
 */
export function applyOneBotAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
  input: {
    wsUrl?: string;
    httpUrl?: string;
    accessToken?: string;
    sharedDir?: string;
    containerSharedDir?: string;
    name?: string;
  },
): OpenClawConfig {
  const next = { ...cfg };
  const patch = {
    ...(input.wsUrl ? { wsUrl: input.wsUrl } : {}),
    ...(input.httpUrl ? { httpUrl: input.httpUrl } : {}),
    ...(input.accessToken ? { accessToken: input.accessToken } : {}),
    ...(input.sharedDir ? { sharedDir: input.sharedDir } : {}),
    ...(input.containerSharedDir ? { containerSharedDir: input.containerSharedDir } : {}),
    ...(input.name ? { name: input.name } : {}),
  };

  if (accountId === DEFAULT_ACCOUNT_ID) {
    next.channels = {
      ...next.channels,
      onebot: {
        ...next.channels?.onebot,
        enabled: true,
        ...patch,
      },
    };
  } else {
    const onebot = next.channels?.onebot as OneBotChannelConfig | undefined;
    next.channels = {
      ...next.channels,
      onebot: {
        ...onebot,
        enabled: true,
        accounts: {
          ...onebot?.accounts,
          [accountId]: {
            ...onebot?.accounts?.[accountId],
            enabled: true,
            ...patch,
          },
        },
      },
    };
  }

  return next;
}

// ── Startup validation ───────────────────────────────────────────────────────

export interface ConfigIssue {
  level: "error" | "warn";
  field: string;
  message: string;
}

/**
 * Configuration check-up, run once per account at gateway start.
 *
 * This exists because the plugin's defaults are permissive: an empty
 * allowFrom accepts every group, and an empty outboundAllow lets the agent
 * message anyone. Those defaults are load-bearing for upgraders, so they stay —
 * but they must not stay silent.
 */
export function validateOneBotConfig(account: ResolvedOneBotAccount): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  const checkUrl = (field: "wsUrl" | "httpUrl", value: string, schemes: string[]) => {
    if (!value) {
      issues.push({ level: "error", field, message: `${field} is not configured` });
      return;
    }
    try {
      const u = new URL(value);
      if (!schemes.includes(u.protocol)) {
        issues.push({
          level: "error",
          field,
          message: `${field} must use ${schemes.join("/")} (got ${u.protocol})`,
        });
      }
    } catch {
      issues.push({ level: "error", field, message: `${field} is not a valid URL: ${value}` });
    }
  };

  checkUrl("wsUrl", account.wsUrl, ["ws:", "wss:"]);
  checkUrl("httpUrl", account.httpUrl, ["http:", "https:"]);

  if (!account.accessToken) {
    issues.push({
      level: "warn",
      field: "accessToken",
      message: "no accessToken configured — anyone who can reach the OneBot endpoint can send events",
    });
  }

  if (!account.allowFrom || account.allowFrom.length === 0) {
    issues.push({
      level: "warn",
      field: "allowFrom",
      message: "allowFrom is empty: every group and every private chat is accepted",
    });
  }

  if (!account.outboundAllow || account.outboundAllow.length === 0) {
    issues.push({
      level: "warn",
      field: "outboundAllow",
      message: "outboundAllow is empty: the agent may send to any chat it can name",
    });
  }

  if (account.replyAudit === false) {
    issues.push({
      level: "warn",
      field: "replyAudit",
      message: "replyAudit is disabled: local paths and credentials are not filtered before send",
    });
  }

  for (const dir of account.mediaAllowDirs ?? []) {
    if (typeof dir === "string" && dir.trim() && !existsSync(dir.trim())) {
      issues.push({
        level: "warn",
        field: "mediaAllowDirs",
        message: `directory does not exist: ${dir}`,
      });
    }
  }

  return issues;
}
