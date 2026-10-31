import type { ResolvedOneBotAccount } from "./types.js";

/**
 * Per-group wake policy.
 *
 * - `all`     — every allowed group message wakes the agent (historical behavior).
 * - `mention` — only an @-mention, the bot's nickname, or a poke wakes it.
 * - `sampled` — mention/poke always wake; other messages wake with
 *               `wakeProbability`. Non-woken messages are recorded and folded
 *               into the next wake as a short digest (zero model calls).
 */
export type WakePolicy = "all" | "mention" | "sampled";

export interface ResolvedWakePolicy {
  policy: WakePolicy;
  probability: number;
}

const DEFAULT_PROBABILITY = 0.05;

function normalizePolicy(value: unknown): WakePolicy | undefined {
  return value === "all" || value === "mention" || value === "sampled" ? value : undefined;
}

/**
 * Resolve the wake policy for one group.
 *
 * Lookup order mirrors OpenClaw's own group policy: exact group id, then `*`,
 * then the account-level default. `requireMention: true` (the host-native way
 * to say "only answer when mentioned") is honoured as `mention`.
 */
export function resolveWakePolicy(
  account: ResolvedOneBotAccount,
  groupId: string | number,
): ResolvedWakePolicy {
  const groups = (account.groups ?? {}) as Record<string, { wakePolicy?: unknown; wakeProbability?: unknown; requireMention?: unknown }>;
  const entry = groups[String(groupId)] ?? groups["*"];

  let policy =
    normalizePolicy(entry?.wakePolicy) ??
    (entry?.requireMention === true ? "mention" : undefined) ??
    normalizePolicy(account.wakePolicy) ??
    "all";

  const rawProbability = entry?.wakeProbability ?? account.wakeProbability;
  const probability =
    typeof rawProbability === "number" && Number.isFinite(rawProbability)
      ? Math.min(1, Math.max(0, rawProbability))
      : DEFAULT_PROBABILITY;

  return { policy, probability };
}

/** True when the message itself is a direct address (mention / nickname / poke). */
export function isWakeMention(params: {
  text: string;
  nickname?: string;
  isPoke?: boolean;
}): boolean {
  if (params.isPoke) return true;
  const text = params.text ?? "";
  if (text.includes("[被@]") || text.includes("[被@全体]")) return true;
  const nick = params.nickname?.trim();
  if (nick && nick.length > 0 && text.toLowerCase().includes(nick.toLowerCase())) return true;
  return false;
}

/**
 * Ring buffer of messages that arrived while the agent was not woken.
 * On the next wake the digest is prepended once, then cleared.
 */
interface DigestEntry {
  id?: number;
  line: string;
}

export class WakeDigest {
  private readonly buffers = new Map<string, DigestEntry[]>();

  constructor(
    private readonly maxMessages = 50,
    private readonly maxChars = 2000,
  ) {}

  record(key: string, line: string, messageId?: number): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    const list = this.buffers.get(key) ?? [];
    list.push({ id: messageId, line: trimmed.slice(0, 200) });
    while (list.length > this.maxMessages) list.shift();
    // Cap by characters too: drop oldest until the digest fits.
    let total = list.reduce((sum, item) => sum + item.line.length + 1, 0);
    while (total > this.maxChars && list.length > 1) {
      const dropped = list.shift();
      total -= (dropped?.line.length ?? 0) + 1;
    }
    this.buffers.set(key, list);
  }

  /**
   * Take and clear the digest for a key. Returns "" when nothing was recorded.
   * `isDropped` lets the caller filter entries that were recalled meanwhile.
   */
  take(key: string, isDropped?: (messageId: number) => boolean): string {
    const list = this.buffers.get(key);
    if (!list || list.length === 0) return "";
    this.buffers.delete(key);
    const kept = isDropped
      ? list.filter((entry) => entry.id == null || !isDropped(entry.id))
      : list;
    if (kept.length === 0) return "";
    return [
      `[群聊未唤醒期间记录·最近 ${kept.length} 条]`,
      ...kept.map((entry) => entry.line),
      "[记录结束]",
    ].join("\n");
  }

  /** Drop a key's buffer (e.g. after a policy change to `all`). */
  clear(key: string): void {
    this.buffers.delete(key);
  }

  size(key: string): number {
    return this.buffers.get(key)?.length ?? 0;
  }
}
