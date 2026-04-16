const WAIT_TIMEOUT = Number(process.env.WAIT_TIMEOUT_MS) || 600_000; // 10 min

export interface IncomingMessage {
  id: string;
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

  /** Remove and return all queued messages. */
  drain(): QueuedMessage[] {
    const drained = this.items;
    this.items = [];
    return drained;
  }

  /** Block until a message arrives or WAIT_TIMEOUT elapses. */
  async waitForMessage(): Promise<void> {
    if (this.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeResolve = null;
        resolve();
      }, WAIT_TIMEOUT);
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
