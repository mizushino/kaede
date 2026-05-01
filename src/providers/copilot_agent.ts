import { CopilotClientManager } from '../core/client.js';
import type { ToolContext } from '../core/tools.js';
import { FunctionLoader } from '../core/functions.js';
import { Inbox, QueuedMessage, IncomingMessage } from '../core/inbox.js';
import type { Messenger } from '../core/messenger.js';
import { loadPermissionConfig } from '../core/permissions.js';
import { logger } from '../core/logger.js';
import type { RequestCounter } from '../core/counter.js';
import type { Scheduler } from '../core/scheduler.js';
import { CopilotCodeProvider, DEFAULT_REASONING_EFFORT, type CopilotSendErrorAction, type ReasoningEffort } from './copilot.js';

const MAX_RETRIES = Number(process.env.MAX_RETRIES) || 5;

export class CopilotAgent implements ToolContext {
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
	private processingPromise: Promise<void> | null = null;
	private readonly provider: CopilotCodeProvider;

	constructor(messenger: Messenger, workspaceDir: string, functionsDir: string, model: string, clientManager: CopilotClientManager, counter: RequestCounter, scheduler: Scheduler, sessionKey?: string, botUserId?: string) {
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
			toolContext: this,
			getModel: () => this.model,
			getReasoningEffort: () => this.reasoningEffort,
		});
	}

	async setModel(model: string, reasoningEffort?: ReasoningEffort | ''): Promise<void> {
		this.model = model;
		if (reasoningEffort !== undefined) this.reasoningEffort = reasoningEffort;
		await this.provider.setModel();
	}

	getRemainingTurnTimeMs(): number | null {
		return this.provider.getRemainingTurnTimeMs();
	}

	async processMessage(message: IncomingMessage, attachments: string[], files: string[] = []): Promise<void> {
		this.queue.push({ message, attachments, files });
		logger.log(`[${this.model}] Queued message (${this.queue.length} pending) [ch:${this.messenger.channelId}]`);

		if (this.processingPromise) return;

		this.processingPromise = this.runProcessingLoop();
		await this.processingPromise;
	}

	private async runProcessingLoop(): Promise<void> {
		try {
			while (true) {
				const items = this.queue.drain();
				if (items.length === 0) break;

				await this.messenger.startTyping();
				this.messenger.setStatus('👀 check_message');

				logger.log(`[${this.model}] Processing ${items.length} message(s)`);
				await this.sendMessages(items);
			}
		} catch (err) {
			logger.error(`[${this.model}] Processing error:`, err);
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
				const attachments = items.flatMap(item => item.attachments);

				logger.log(`[${this.model}] Sending prompt (attempt ${attempt}):\n${prompt.slice(0, 300)}`);

				this.counter.startRequest(this.model, items.length);
				try {
					await this.provider.sendPrompt(prompt, { attachments });
				} finally {
					this.counter.finalizeRequest();
				}

				logger.log(`[${this.model}] Processing complete`);
				return;
			} catch (err) {
				const msg = (err as Error).message || '';
				logger.log(`[${this.model}] Attempt ${attempt}/${MAX_RETRIES} failed: ${msg.slice(0, 120)}`);
				const action = await this.provider.handleSendError(err as Error);
				if (action === 'stop') return;
				if (this.shouldRetry(action, attempt)) {
					await new Promise(r => setTimeout(r, attempt * 2000));
					continue;
				}
				if (action === 'connection') {
					logger.error(`[${this.model}] Connection failed after ${MAX_RETRIES} retries, message dropped`);
					return;
				}

				logger.error(`[${this.model}] Error:`, err);
				await this.messenger.sendError(msg);
				return;
			}
		}
	}

	private shouldRetry(action: CopilotSendErrorAction, attempt: number): boolean {
		if (attempt >= MAX_RETRIES) return false;
		return action === 'retry' || action === 'connection';
	}

	private buildPrompt(items: QueuedMessage[]): string {
		const messageData = items.map(item => ({
			id: item.message.id,
			channelId: item.message.channelId,
			author: item.message.author,
			content: item.message.content,
			hasAttachments: item.attachments.length > 0,
			...(item.files.length > 0 ? { files: item.files } : {}),
		}));

		const allFiles = items.flatMap(item => item.files);
		const fileNote = allFiles.length > 0
			? `\n\nAttached files (use view tool to read): ${allFiles.join(', ')}`
			: '';

		return `${JSON.stringify(messageData)}${fileNote}

Important: Use send_message to respond. You may reply to a specific message by including its messageId. Only respond to messages directed at you based on context.
send_message
channelId: (use the channelId from the message you want to reply to)
messageId: (Optional - use the ID of the message you want to reply to from the JSON above)`;
	}

	async dispose(): Promise<void> {
		this.queue.abort();
		this.messenger.stopTyping();
		this.messenger.clearStatus();
		this.provider.dispose();
	}

	async deleteSession(): Promise<void> {
		await this.provider.deleteSession();
	}
}