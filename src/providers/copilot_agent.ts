import { CopilotClientManager } from '../core/client.js';
import { FunctionLoader } from '../core/functions.js';
import { Inbox, QueuedMessage } from '../core/inbox.js';
import type { Messenger } from '../core/messenger.js';
import { loadPermissionConfig } from '../core/permissions.js';
import { logger } from '../core/logger.js';
import { buildIncomingMessagePrompt } from '../core/prompt_helpers.js';
import type { RequestCounter } from '../core/counter.js';
import type { Scheduler } from '../core/scheduler.js';
import { BaseAgent } from './base_agent.js';
import { CopilotCodeProvider, DEFAULT_REASONING_EFFORT, type CopilotSendErrorAction, type ReasoningEffort } from './copilot.js';

export class CopilotAgent extends BaseAgent {
	model: string;
	reasoningEffort: ReasoningEffort | '';
	messenger: Messenger;
	queue = new Inbox();
	readonly functionLoader: FunctionLoader;
	readonly counter: RequestCounter;
	readonly scheduler: Scheduler;
	readonly sessionKey: string;
	readonly botUserId: string;

	private readonly clientManager: CopilotClientManager;
	private readonly workspaceDir: string;
	protected readonly provider: CopilotCodeProvider;

	constructor(messenger: Messenger, workspaceDir: string, functionsDir: string, model: string, clientManager: CopilotClientManager, counter: RequestCounter, scheduler: Scheduler, sessionKey?: string, botUserId?: string) {
		super();
		this.messenger = messenger;
		this.workspaceDir = workspaceDir;
		this.model = model;
		this.reasoningEffort = DEFAULT_REASONING_EFFORT;
		this.clientManager = clientManager;
		this.botUserId = botUserId ?? '';
		this.functionLoader = new FunctionLoader(functionsDir);
		this.counter = counter;
		this.scheduler = scheduler;
		this.sessionKey = sessionKey ?? messenger.channelId;
		this.provider = new CopilotCodeProvider({
			channelId: messenger.channelId,
			messenger,
			workspaceDir,
			sessionKey: this.sessionKey,
			clientManager,
			functionLoader: this.functionLoader,
			permissionConfig: loadPermissionConfig(),
			botUserId: this.botUserId,
			getModel: () => this.model,
			getReasoningEffort: () => this.reasoningEffort,
			createToolContext: () => ({
				model: this.model,
				queue: this.queue,
				messenger: this.messenger,
				counter: this.counter,
				scheduler: this.scheduler,
				getRemainingTurnTimeMs: () => this.provider.getRemainingTurnTimeMs(),
			}),
		});
	}

	protected logTag(): string {
		return this.model;
	}

	protected buildPrompt(items: QueuedMessage[]): string {
		return buildIncomingMessagePrompt(items, {
			suffix: `Important: Use send_message to respond. You may reply to a specific message by including its messageId. Only respond to messages directed at you based on context.
send_message
channelId: (use the channelId from the message you want to reply to)
messageId: (Optional - use the ID of the message you want to reply to from the JSON above)`,
		});
	}

	protected async attemptSend(items: QueuedMessage[], attempt: number): Promise<'done' | 'retry' | 'fatal'> {
		try {
			const prompt = this.buildPrompt(items);
			const attachments = items.flatMap(item => item.attachments);

			logger.log(`[${this.model}] Sending prompt (attempt ${attempt}):\n${prompt.slice(0, 300)}`);

			this.counter.startRequest(this.model, items.length);
			try {
				await this.provider.sendPrompt(prompt, { attachments });
			} finally {
				this.counter.finalizeRequest();
			}

			logger.log(`[${this.model}] Processing complete`);
			return 'done';
		} catch (err) {
			const msg = (err as Error).message || '';
			logger.log(`[${this.model}] Attempt ${attempt}/${this.maxRetries} failed: ${msg.slice(0, 120)}`);
			const action = await this.provider.handleSendError(err as Error);
			if (action === 'stop') return 'fatal';
			if (this.shouldRetry(action, attempt)) return 'retry';
			if (action === 'connection') {
				logger.error(`[${this.model}] Connection failed after ${this.maxRetries} retries, message dropped`);
				return 'fatal';
			}

			logger.error(`[${this.model}] Error:`, err);
			await this.messenger.sendError(msg);
			return 'fatal';
		}
	}

	private shouldRetry(action: CopilotSendErrorAction, attempt: number): boolean {
		if (attempt >= this.maxRetries) return false;
		return action === 'retry' || action === 'connection';
	}
}