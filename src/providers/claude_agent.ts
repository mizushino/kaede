import path from 'path';
import type { Messenger } from '../core/messenger.js';
import { Inbox, QueuedMessage, IncomingMessage } from '../core/inbox.js';
import type { RequestCounter } from '../core/counter.js';
import type { Scheduler } from '../core/scheduler.js';
import type { Agent } from '../core/bot.js';
import { getClaudeDiscordPromptSignatures } from '../core/tool_contract.js';
import { buildDeferredReplyMarker, consumeDeferredReplies, writePendingQueueSnapshot } from '../core/queue_state.js';
import { ClaudeCodeProvider } from './claude.js';
import { BaseProvider } from './provider.js';
import { logger } from '../core/logger.js';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

const MAX_RETRIES = Number(process.env.MAX_RETRIES) || 5;
const PROVIDER_NAME = 'claude';

export class ClaudeAgent implements Agent {
  model: string;
  reasoningEffort: ReasoningEffort | '' = '';
  messenger: Messenger;
  queue = new Inbox();
  readonly counter: RequestCounter;
  readonly scheduler: Scheduler;
  readonly sessionKey: string;
  readonly botUserId: string;

  private workspaceDir: string;
  private processingPromise: Promise<void> | null = null;
  private provider: BaseProvider;

  constructor(
    messenger: Messenger,
    workspaceDir: string,
    model: string,
    counter: RequestCounter,
    scheduler: Scheduler,
    sessionKey?: string,
    botUserId?: string,
  ) {
    this.messenger = messenger;
    this.workspaceDir = workspaceDir;
    this.model = model;
    this.counter = counter;
    this.scheduler = scheduler;
    this.sessionKey = sessionKey ?? messenger.channelId;
    this.botUserId = botUserId ?? '';
    this.provider = this.createProvider();
  }

  async setModel(model: string, reasoningEffort?: ReasoningEffort | ''): Promise<void> {
    this.model = model;
    if (reasoningEffort !== undefined) this.reasoningEffort = reasoningEffort;
    this.provider.dispose();
    this.provider = this.createProvider();
  }

  sendToTerminal(text: string): void {
    this.provider.sendToTerminal(text);
  }

  async processMessage(message: IncomingMessage, attachments: string[], files: string[] = []): Promise<void> {
    this.queue.push({ message, attachments, files });
    await this.syncPendingQueueSnapshot();
    logger.log(`[${PROVIDER_NAME}:${this.model || 'default'}] Queued message (${this.queue.length} pending) [ch:${this.messenger.channelId}]`);

    if (this.processingPromise) return;

    this.processingPromise = this.runProcessingLoop();
    await this.processingPromise;
  }

  private async runProcessingLoop(): Promise<void> {
    try {
      while (true) {
        const items = this.queue.drain();
        await this.syncPendingQueueSnapshot();
        if (items.length === 0) break;

        await this.messenger.startTyping();
        this.messenger.setStatus('👀 check_message');

        logger.log(`[${PROVIDER_NAME}:${this.model || 'default'}] Processing ${items.length} message(s)`);
        await this.sendMessages(items);
      }
    } catch (err) {
      logger.error(`[${PROVIDER_NAME}:${this.model || 'default'}] Processing error:`, err);
    } finally {
      this.processingPromise = null;
      this.messenger.stopTyping();
      this.messenger.clearStatus();
      this.messenger.setIdle();
    }
  }

  private async sendMessages(items: QueuedMessage[]): Promise<void> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const prompt = this.buildPrompt(items);
        logger.log(`[${PROVIDER_NAME}:${this.model || 'default'}] Sending prompt (attempt ${attempt}):\n${prompt.slice(0, 300)}`);

        this.counter.startRequest(`${PROVIDER_NAME}:${this.model || 'default'}`, items.length);
        try {
          await this.provider.sendPrompt(prompt, {
            model: this.model || undefined,
            reasoningEffort: this.reasoningEffort || undefined,
          });
          await this.restoreDeferredReplies();
        } finally {
          this.counter.finalizeRequest();
        }

        logger.log(`[${PROVIDER_NAME}:${this.model || 'default'}] Prompt completed`);
        return;
      } catch (err) {
        const msg = (err as Error).message || '';
        logger.log(`[${PROVIDER_NAME}:${this.model || 'default'}] Attempt ${attempt}/${MAX_RETRIES} failed: ${msg.slice(0, 120)}`);

        this.provider.dispose();
        this.provider = this.createProvider();

        if (msg.includes('authentication failed')) {
          logger.error(`[${PROVIDER_NAME}:${this.model || 'default'}] Error:`, err);
          await this.messenger.sendError(msg);
          return;
        }

        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, attempt * 2_000));
          continue;
        }

        logger.error(`[${PROVIDER_NAME}:${this.model || 'default'}] Error:`, err);
        await this.messenger.sendError(msg);
      }
    }
  }

  private buildPrompt(items: QueuedMessage[]): string {
    const messageData = items.map(item => ({
      id: item.message.id,
      channelId: item.message.channelId,
      author: item.message.author,
      content: item.message.content,
      hasAttachments: item.attachments.length > 0,
      attachments: item.attachments,
      ...(item.files.length > 0 ? { files: item.files } : {}),
    }));

    const allFiles = items.flatMap(item => item.files);
    const fileNote = allFiles.length > 0
      ? `\n\nAttached files (read them from disk if needed): ${allFiles.join(', ')}`
      : '';

    return `${JSON.stringify(messageData)}${fileNote}

You are an AI agent running inside ${this.provider.getRuntimeLabel()}.
Your working directory is ${path.resolve(this.workspaceDir)}.
Always respond in the same language as the user's message.
Only respond to messages directed at you based on context.
Use the Discord MCP tool to send responses. Preferred tool names are:
${getClaudeDiscordPromptSignatures().join('\n')}
If your provider exposes these tools with different names, use the equivalent Discord send_message tool.
When you need clarification or want the user to choose from options, prefer the Discord ask_user tool instead of only describing a question in plain text.
Do not use the built-in AskUserQuestion tool. In this bot environment, interactive questions must go through the Discord ask_user MCP tool.
If send_message reports queued/new_messages_waiting, treat the current reply as stale and do not force it out.
When replying, use the channelId from the message and include messageId when replying to a specific message.`;
  }

  async dispose(): Promise<void> {
    this.queue.abort();
    await this.syncPendingQueueSnapshot();
    this.messenger.stopTyping();
    this.messenger.clearStatus();
    this.provider.dispose();
  }

  async deleteSession(): Promise<void> {
    await this.provider.deleteSession();
    await this.syncPendingQueueSnapshot();
  }

  private async syncPendingQueueSnapshot(): Promise<void> {
    try {
      await writePendingQueueSnapshot(
        this.sessionKey,
        this.queue.snapshot().map(item => ({
          id: item.message.id,
          channelId: item.message.channelId,
          author: item.message.author,
          content: item.message.content,
          attachments: item.attachments,
          files: item.files,
        })),
      );
    } catch (err) {
      logger.error(`[${PROVIDER_NAME}:${this.model || 'default'}] Failed to sync pending queue snapshot:`, err);
    }
  }

  private async restoreDeferredReplies(): Promise<void> {
    try {
      const deferredReplies = await consumeDeferredReplies(this.sessionKey);
      if (deferredReplies.length === 0) return;

      for (let index = deferredReplies.length - 1; index >= 0; index--) {
        const deferred = deferredReplies[index];
        const unsentMarker = buildDeferredReplyMarker(deferred);

        this.queue.pushFront({
          message: {
            id: deferred.id || `unsent-${Date.now()}`,
            channelId: deferred.channelId,
            author: this.model,
            content: unsentMarker,
          },
          attachments: [],
          files: [],
        });
      }

      await this.syncPendingQueueSnapshot();
      logger.log(`[${PROVIDER_NAME}:${this.model || 'default'}] Re-queued ${deferredReplies.length} deferred reply draft(s)`);
    } catch (err) {
      logger.error(`[${PROVIDER_NAME}:${this.model || 'default'}] Failed to restore deferred replies:`, err);
    }
  }

  private createProvider(): BaseProvider {
    return new ClaudeCodeProvider({
      channelId: this.messenger.channelId,
      messenger: this.messenger,
      workspaceDir: this.workspaceDir,
      sessionKey: this.sessionKey,
    });
  }
}
