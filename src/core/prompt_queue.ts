/**
 * Async iterable backed by a FIFO queue. Producers call `push()` to enqueue
 * items; consumers iterate via `for await`. Calling `close()` ends the
 * iteration after any buffered items are drained.
 */
export class PromptQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private resolvers: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Drain buffered items to waiting resolvers first
    while (this.buffer.length > 0 && this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!;
      resolver({ value: this.buffer.shift()!, done: false });
    }
    // Signal done to remaining resolvers
    for (const resolver of this.resolvers) {
      resolver({ value: undefined as unknown as T, done: true });
    }
    this.resolvers = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>(resolve => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}
