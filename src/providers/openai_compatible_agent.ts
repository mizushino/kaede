import path from 'path';
import type { Messenger } from '../core/messenger.js';
import type { RequestCounter } from '../core/counter.js';
import type { Scheduler } from '../core/scheduler.js';
import type { QueuedMessage } from '../core/messages.js';
import { FunctionLoader } from '../core/functions.js';
import { buildIncomingMessagePrompt } from '../core/prompt_helpers.js';
import { BaseAgent, type ModelListing } from './base_agent.js';
import { OpenAICompatibleProvider } from './openai_compatible.js';

export class OpenAICompatibleAgent extends BaseAgent {
  protected readonly provider: OpenAICompatibleProvider;
  readonly functionLoader: FunctionLoader;

  constructor(
    messenger: Messenger,
    workspaceDir: string,
    model: string,
    counter: RequestCounter,
    scheduler: Scheduler,
    sessionKey?: string,
    botUserId?: string,
  ) {
    super(messenger, workspaceDir, model, counter, scheduler, sessionKey, botUserId);
    const functionsDir = process.env.FUNCTIONS_DIR || path.join(workspaceDir, 'functions');
    this.functionLoader = new FunctionLoader(functionsDir);
    this.provider = new OpenAICompatibleProvider({
      channelId: messenger.channelId,
      messenger,
      workspaceDir,
      sessionKey: this.sessionKey,
      functionLoader: this.functionLoader,
      botUserId: this.botUserId,
      getModel: () => this.model,
      createToolContext: () => ({
        model: this.model,
        queue: this.queue,
        messenger: this.messenger,
        counter: this.counter,
        scheduler: this.scheduler,
      }),
    });
  }

  static async listModels(): Promise<ModelListing> {
    const models = await OpenAICompatibleProvider.listModels();
    return {
      models: models.map(model => ({
        id: model.id,
        displayName: model.displayName,
        effort: model.effort,
        autocompleteLabel: model.displayName,
      })),
      columns: [
        { key: 'id', header: 'MODEL' },
        { key: 'effort', header: 'EFFORT' },
      ],
    };
  }

  protected logTag(): string {
    return `openai:${this.model || 'default'}`;
  }

  protected buildPrompt(items: QueuedMessage[]): string {
    return buildIncomingMessagePrompt(items, {
      suffix: `Important: Use send_message to respond. You may reply to a specific message by including its messageId. Only respond to messages directed at you based on context.
send_message
channelId: (use the channelId from the message you want to reply to)
messageId: (Optional - use the ID of the message you want to reply to from the JSON above)`,
    });
  }

  protected async attemptSend(items: QueuedMessage[], _attempt: number): Promise<'done' | 'retry' | 'fatal'> {
    const prompt = this.buildPrompt(items);
    const attachments = items.flatMap(item => item.attachments ?? []);
    this.counter.startRequest(this.logTag(), items.length);
    try {
      await this.provider.sendPrompt(prompt, { model: this.model || undefined, attachments });
      return 'done';
    } catch (err) {
      const message = (err as Error).message || String(err);
      await this.messenger.sendError(message);
      return 'fatal';
    } finally {
      this.counter.finalizeRequest();
    }
  }
}
