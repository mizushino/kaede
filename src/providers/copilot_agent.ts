import path from 'path';
import { CopilotClientManager } from '../core/client.js';
import { FunctionLoader } from '../core/functions.js';
import { QueuedMessage } from '../core/inbox.js';
import type { Messenger } from '../core/messenger.js';
import { loadPermissionConfig } from '../core/permissions.js';
import { logger } from '../core/logger.js';
import { buildIncomingMessagePrompt } from '../core/prompt_helpers.js';
import type { RequestCounter } from '../core/counter.js';
import type { Scheduler } from '../core/scheduler.js';
import { BaseAgent, type ModelListing } from './base_agent.js';
import { CopilotCodeProvider, DEFAULT_REASONING_EFFORT, type CopilotSendErrorAction, type ReasoningEffort } from './copilot.js';

export class CopilotAgent extends BaseAgent {
	/** Shared Copilot client manager for the process. Lazily created. */
	private static sharedClientManager: CopilotClientManager | null = null;

	static getClientManager(): CopilotClientManager {
		if (!this.sharedClientManager) {
			this.sharedClientManager = new CopilotClientManager();
		}
		return this.sharedClientManager;
	}

	/** Pre-initialize the shared Copilot client to reduce first-message latency. */
	static async warmup(): Promise<void> {
		await this.getClientManager().warmup();
	}

	/** Shut down the shared Copilot client. Safe to call even if never used. */
	static async shutdownProcess(): Promise<void> {
		const mgr = this.sharedClientManager;
		if (!mgr) return;
		this.sharedClientManager = null;
		await mgr.shutdown();
	}

	static async listModels(): Promise<ModelListing> {
		// The Copilot SDK's client.listModels() queries GitHub's model catalog,
		// which doesn't include models from custom OpenAI-compatible providers.
		// Fetch from the custom provider directly to show the correct model list.
		const baseUrl = process.env.COPILOT_PROVIDER_BASE_URL?.replace(/\/+$/, '');
		const apiKey = process.env.COPILOT_PROVIDER_API_KEY;

		if (baseUrl && apiKey) {
			try {
				const res = await fetch(`${baseUrl}/models`, {
					headers: { 'Authorization': `Bearer ${apiKey}` },
				});
				if (res.ok) {
					const data = await res.json() as { data?: Array<{ id: string }> };
					if (data.data?.length) {
						return {
							models: data.data.map(m => ({
								id: m.id,
								displayName: m.id,
								cost: '-',
								reasoning: '-',
								autocompleteLabel: m.id,
							})),
							columns: [
								{ key: 'id', header: 'MODEL' },
							],
						};
					}
				}
			} catch (e) {
				logger.log(`[COPILOT] Failed to fetch models from custom provider: ${(e as Error).message?.slice(0, 100)}`);
			}
		}

		// Fallback to Copilot SDK when no custom provider is configured
		// or when the custom provider request failed
		const client = await this.getClientManager().getClient();
		const models = await client.listModels();
		return {
			models: models.map(m => ({
				id: m.id,
				displayName: m.id,
				cost: m.billing?.multiplier != null ? `${m.billing.multiplier}x` : '?',
				reasoning: m.supportedReasoningEfforts?.join('/') ?? '-',
				autocompleteLabel: m.billing?.multiplier != null ? `${m.id} (${m.billing.multiplier}x)` : m.id,
			})),
			columns: [
				{ key: 'id', header: 'MODEL' },
				{ key: 'cost', header: 'COST' },
				{ key: 'reasoning', header: 'REASONING' },
			],
		};
	}

	private readonly clientManager: CopilotClientManager;
	protected readonly provider: CopilotCodeProvider;
	readonly functionLoader: FunctionLoader;

	constructor(messenger: Messenger, workspaceDir: string, model: string, counter: RequestCounter, scheduler: Scheduler, sessionKey?: string, botUserId?: string) {
		super(messenger, workspaceDir, model, counter, scheduler, sessionKey, botUserId);
		this.reasoningEffort = DEFAULT_REASONING_EFFORT;
		this.clientManager = CopilotAgent.getClientManager();
		const functionsDir = process.env.FUNCTIONS_DIR || path.join(workspaceDir, 'functions');
		this.functionLoader = new FunctionLoader(functionsDir);
		this.provider = new CopilotCodeProvider({
			channelId: messenger.channelId,
			messenger,
			workspaceDir,
			sessionKey: this.sessionKey,
			clientManager: this.clientManager,
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
			const attachments = items.flatMap(item => item.attachments ?? []);

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