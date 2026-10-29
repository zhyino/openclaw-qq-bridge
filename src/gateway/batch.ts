import type { OneBotMessageEvent, OneBotMessageSegment } from "../types.js";

export interface BufferedMessage {
  event: OneBotMessageEvent;
  text: string;
  images: string[];
  recordSegments: OneBotMessageSegment[];
}

interface PendingBatch {
  messages: BufferedMessage[];
  timer: ReturnType<typeof setTimeout>;
  totalChars: number;
}

export interface MessageBatcherOptions {
  gapMs: number;
  maxMessages: number;
  maxChars: number;
  onFlush: (batchKey: string, messages: BufferedMessage[]) => void | Promise<void>;
  onError?: (err: unknown) => void;
}

/**
 * Coalesces rapid-fire messages from the same chat+sender into one dispatch.
 *
 * Extracted from `startGateway` (where it lived as a 120-line chain of nested
 * `setTimeout` closures) so the timing rules can be reasoned about and tested
 * without a WebSocket: reset timer on each message, flush on overflow, flush
 * everything on dispose.
 */
export class MessageBatcher {
  private readonly batches = new Map<string, PendingBatch>();

  constructor(private readonly options: MessageBatcherOptions) {}

  push(batchKey: string, message: BufferedMessage): void {
    const existing = this.batches.get(batchKey);

    if (!existing) {
      this.start(batchKey, [message], message.text.length);
      return;
    }

    const overflows =
      existing.messages.length >= this.options.maxMessages ||
      existing.totalChars + message.text.length > this.options.maxChars;

    if (overflows) {
      // Flush what we have and open a fresh batch with this message.
      this.flush(batchKey);
      this.start(batchKey, [message], message.text.length);
      return;
    }

    existing.messages.push(message);
    existing.totalChars += message.text.length;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => this.flush(batchKey), this.options.gapMs);
  }

  /** Flush one chat immediately (used by tests and shutdown paths). */
  flush(batchKey: string): void {
    const batch = this.batches.get(batchKey);
    if (!batch) return;

    clearTimeout(batch.timer);
    this.batches.delete(batchKey);

    try {
      const result = this.options.onFlush(batchKey, batch.messages);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((err) => this.options.onError?.(err));
      }
    } catch (err) {
      this.options.onError?.(err);
    }
  }

  /** Drop every pending batch (shutdown: messages in flight are abandoned). */
  dispose(): void {
    for (const batch of this.batches.values()) {
      clearTimeout(batch.timer);
    }
    this.batches.clear();
  }

  get pendingBatches(): number {
    return this.batches.size;
  }

  private start(batchKey: string, messages: BufferedMessage[], totalChars: number): void {
    const timer = setTimeout(() => this.flush(batchKey), this.options.gapMs);
    this.batches.set(batchKey, { messages, timer, totalChars });
  }
}
