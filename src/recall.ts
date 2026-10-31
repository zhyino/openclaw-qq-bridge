/**
 * Recall (撤回) tracking.
 *
 * OneBot emits `notice/group_recall` and `notice/friend_recall` with the
 * recalled `message_id`. The bridge batches messages (≈1.5s) and then waits a
 * natural reply delay, so a user can easily recall a message before the agent
 * turn starts — replying to a recalled message is a visible bug.
 *
 * We keep a small TTL map of recalled ids:
 *  - dispatchBatch drops recalled messages before summarising (and skips the
 *    turn entirely when every message was recalled);
 *  - the deliver callback suppresses a reply when every message in the batch
 *    has been recalled mid-turn.
 */
export class RecallTracker {
  private readonly recalled = new Map<number, number>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly maxEntries = 500,
  ) {}

  mark(messageId: number): void {
    if (!Number.isFinite(messageId) || messageId === 0) return;
    this.recalled.set(messageId, Date.now());
    this.prune();
  }

  isRecalled(messageId: number): boolean {
    this.prune();
    return this.recalled.has(messageId);
  }

  /** True when every id is recalled (an empty list is not "all recalled"). */
  allRecalled(messageIds: readonly number[]): boolean {
    if (messageIds.length === 0) return false;
    return messageIds.every((id) => this.isRecalled(id));
  }

  get size(): number {
    this.prune();
    return this.recalled.size;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, ts] of this.recalled) {
      if (now - ts > this.ttlMs) this.recalled.delete(id);
    }
    while (this.recalled.size > this.maxEntries) {
      const oldest = this.recalled.keys().next();
      if (oldest.done) break;
      this.recalled.delete(oldest.value);
    }
  }
}
