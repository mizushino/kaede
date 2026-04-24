const DEFAULT_WAIT_TIMEOUT = Number(process.env.WAIT_TIMEOUT_MS) || 1_800_000; // 30 min

export interface IncomingMessage {
  id: string;
  channelId: string;
  author: string;
  content: string;
}

export interface QueuedMessage {
  message: IncomingMessage;
  attachments: string[];
  files: string[];
}

export class Inbox {
  private items: QueuedMessage[] = [];
  private wakeResolve: (() => void) | null = null;
  private aborted = false;

  get length(): number {
    return this.items.length;
  }

  /** Add a message to the queue and wake any waiting consumer. */
  push(item: QueuedMessage): void {
    this.items.push(item);
    if (this.wakeResolve) {
      this.wakeResolve();
    }
  }

  /** Add a message to the front of the queue and wake any waiting consumer. */
  pushFront(item: QueuedMessage): void {
    this.items.unshift(item);
    if (this.wakeResolve) {
      this.wakeResolve();
    }
  }

  /** Remove and return all queued messages. */
  drain(): QueuedMessage[] {
    const drained = this.items;
    this.items = [];
    return drained;
  }

  /** Block until a message arrives or the provided timeout elapses. */
  async waitForMessage(timeoutMs = DEFAULT_WAIT_TIMEOUT): Promise<void> {
    if (this.aborted) return;
    if (this.items.length > 0) return;  // already have messages, no need to wait
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeResolve = null;
        resolve();
      }, timeoutMs);
      this.wakeResolve = () => {
        clearTimeout(timer);
        this.wakeResolve = null;
        resolve();
      };
    });
  }

  /** Abort any pending wait so the consumer can exit. */
  abort(): void {
    this.aborted = true;
    if (this.wakeResolve) {
      this.wakeResolve();
    }
  }
}
