import type { Agent } from '../core/bot.js';
import type { RequestCounter } from '../core/counter.js';
import type { Inbox, IncomingMessage, QueuedMessage } from '../core/inbox.js';
import type { Messenger } from '../core/messenger.js';
import type { Scheduler } from '../core/scheduler.js';
import { logger } from '../core/logger.js';
import type { BaseProvider, ContextUsageInfo, ReasoningEffort } from './provider.js';

const DEFAULT_MAX_RETRIES = Number(process.env.MAX_RETRIES) || 5;

/**
 * Shared lifecycle scaffolding for every agent. Subclasses provide a provider,
 * a prompt builder and an attempt strategy. The base owns the message queue,
 * processing loop and dispose plumbing common to all providers.
 */
export abstract class BaseAgent implements Agent {
  abstract model: string;
  abstract reasoningEffort: ReasoningEffort | '';
  abstract messenger: Messenger;
  abstract readonly counter: RequestCounter;
  abstract readonly scheduler: Scheduler;
  abstract readonly sessionKey: string;
  abstract readonly botUserId: string;
  abstract queue: Inbox;

  protected processingPromise: Promise<void> | null = null;
  protected readonly maxRetries = DEFAULT_MAX_RETRIES;

  protected abstract get provider(): BaseProvider;
  protected abstract logTag(): string;
  protected abstract buildPrompt(items: QueuedMessage[]): string;
  /**
   * Execute one send attempt. Return:
   * - `done`: stop the retry loop with success
   * - `retry`: schedule another attempt (loop will sleep then retry)
   * - `fatal`: stop and report the error to the user
   */
  protected abstract attemptSend(items: QueuedMessage[], attempt: number): Promise<'done' | 'retry' | 'fatal'>;

  /** Optional hook fired before/after each processing iteration. */
  protected async beforeIteration(): Promise<void> {}
  protected async afterIterationError(_err: unknown): Promise<void> {}

  async setModel(model: string, reasoningEffort?: ReasoningEffort | ''): Promise<void> {
    this.model = model;
    if (reasoningEffort !== undefined) this.reasoningEffort = reasoningEffort;
    await this.provider.setModel();
  }

  getRemainingTurnTimeMs(): number | null {
    return this.provider.getRemainingTurnTimeMs();
  }

  async getContextUsage(): Promise<ContextUsageInfo | null> {
    return this.provider.getContextUsage();
  }

  async processMessage(message: IncomingMessage, attachments: string[], files: string[] = []): Promise<void> {
    this.queue.push({ message, attachments, files });
    await this.beforeIteration();
    logger.log(`[${this.logTag()}] Queued message (${this.queue.length} pending) [ch:${this.messenger.channelId}]`);

    if (!this.processingPromise) {
      this.processingPromise = this.runProcessingLoop();
    }
    const promise = this.processingPromise;
    await promise;

    // Race guard: a message may have been pushed after the loop drained but
    // before its `finally` cleared `processingPromise`. If so, the loop exited
    // without processing it. Restart processing here for any leftover items.
    if (this.queue.length > 0 && !this.processingPromise) {
      this.processingPromise = this.runProcessingLoop();
      await this.processingPromise;
    }
  }

  protected async runProcessingLoop(): Promise<void> {
    let loopError: unknown;
    try {
      while (true) {
        const items = this.queue.drain();
        await this.beforeIteration();
        if (items.length === 0) break;

        await this.messenger.startTyping();
        this.messenger.setStatus('👀 check_message');

        logger.log(`[${this.logTag()}] Processing ${items.length} message(s)`);
        await this.sendMessages(items);
      }
    } catch (err) {
      loopError = err;
      logger.error(`[${this.logTag()}] Processing error:`, err);
      await this.afterIterationError(err);
      await this.messenger.sendError((err as Error).message || String(err)).catch(() => {});
    } finally {
      this.processingPromise = null;
      this.messenger.stopTyping();
      this.messenger.clearStatus();
      this.messenger.setIdle();
    }
    if (loopError) throw loopError;
  }

  protected async sendMessages(items: QueuedMessage[]): Promise<void> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const outcome = await this.attemptSend(items, attempt);
      if (outcome === 'done' || outcome === 'fatal') return;
      if (attempt < this.maxRetries) {
        await new Promise(r => setTimeout(r, attempt * 2_000));
      }
    }
  }

  async dispose(): Promise<void> {
    this.queue.abort();
    this.messenger.dispose();
    this.provider.dispose();
  }

  async deleteSession(): Promise<void> {
    await this.provider.deleteSession();
  }
}
