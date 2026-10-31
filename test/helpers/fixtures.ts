import type { ResolvedOneBotAccount } from "../../src/types.js";

/**
 * Single source of truth for test accounts.
 *
 * Why this file exists: every test used to build its own `account` literal, and
 * because `tsconfig.json` excluded `test/`, the compiler never checked them. That
 * is exactly how `mediaAllowDirs` went missing for three releases — a hand-built
 * fixture silently diverged from the runtime shape and nothing failed.
 *
 * Add a required field to `ResolvedOneBotAccount` and this file is the only place
 * that needs to change. The compiler enforces it.
 */
export function makeAccount(
  overrides: Partial<ResolvedOneBotAccount> = {},
): ResolvedOneBotAccount {
  return {
    accountId: "default",
    enabled: true,
    wsUrl: "ws://127.0.0.1:0",
    httpUrl: "http://127.0.0.1:0",
    groupAutoReact: false,
    groupAutoReactEmojiId: 1,
    replyAudit: true,
    qzoneWrite: false,
    muteSystemNotices: true,
    ignoreBots: true,
    botMinIntervalSec: 60,
    outboundRateLimit: 0,
    replyDelaySec: 0,
    config: {},
    ...overrides,
  };
}
