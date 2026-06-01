import path from 'path';
import { CopilotClientManager } from '../core/client.js';
import { FunctionLoader } from '../core/functions.js';
import type { QueuedMessage } from '../core/messages.js';
import type { Messenger } from '../core/messenger.js';
import { loadPermissionConfig } from '../core/permissions.js';
import { logger } from '../core/logger.js';
import { buildIncomingMessagePrompt } from '../core/prompt_helpers.js';
import type { RequestCounter } from '../core/counter.js';
import type { Scheduler } from '../core/scheduler.js';
import { BaseAgent, type ModelListing } from './base_agent.js';
import { CopilotCodeProvider, DEFAULT_REASONING_EFFORT, type CopilotSendErrorAction, type ReasoningEffort } from './copilot.js';

type TokenPricing = {
	input: string;
	cachedInput: string;
	output: string;
	cachedOutput: string;
};

const COPILOT_TOKEN_PRICING: Record<string, TokenPricing> = {
	// Fallback for GitHub's June 2026 token pricing until Copilot SDK
	// models.list exposes the token price fields directly.
	'gpt-4.1': { input: '$2', cachedInput: '$0.5', output: '$8', cachedOutput: '-' },
	'gpt-5 mini': { input: '$0.25', cachedInput: '$0.025', output: '$2', cachedOutput: '-' },
	'gpt-5-mini': { input: '$0.25', cachedInput: '$0.025', output: '$2', cachedOutput: '-' },
	'gpt-5.2': { input: '$1.75', cachedInput: '$0.175', output: '$14', cachedOutput: '-' },
	'gpt-5.2-codex': { input: '$1.75', cachedInput: '$0.175', output: '$14', cachedOutput: '-' },
	'gpt-5.3-codex': { input: '$1.75', cachedInput: '$0.175', output: '$14', cachedOutput: '-' },
	'gpt-5.4': { input: '$2.5', cachedInput: '$0.25', output: '$15', cachedOutput: '-' },
	'gpt-5.4 mini': { input: '$0.75', cachedInput: '$0.075', output: '$4.5', cachedOutput: '-' },
	'gpt-5.4-mini': { input: '$0.75', cachedInput: '$0.075', output: '$4.5', cachedOutput: '-' },
	'gpt-5.4 nano': { input: '$0.2', cachedInput: '$0.02', output: '$1.25', cachedOutput: '-' },
	'gpt-5.4-nano': { input: '$0.2', cachedInput: '$0.02', output: '$1.25', cachedOutput: '-' },
	'gpt-5.5': { input: '$5', cachedInput: '$0.5', output: '$30', cachedOutput: '-' },
	'claude-haiku-4.5': { input: '$1', cachedInput: '$0.1', output: '$5', cachedOutput: '$1.25' },
	'claude-sonnet-4': { input: '$3', cachedInput: '$0.3', output: '$15', cachedOutput: '$3.75' },
	'claude-sonnet-4.5': { input: '$3', cachedInput: '$0.3', output: '$15', cachedOutput: '$3.75' },
	'claude-sonnet-4.6': { input: '$3', cachedInput: '$0.3', output: '$15', cachedOutput: '$3.75' },
	'claude-opus-4.5': { input: '$5', cachedInput: '$0.5', output: '$25', cachedOutput: '$6.25' },
	'claude-opus-4.6': { input: '$5', cachedInput: '$0.5', output: '$25', cachedOutput: '$6.25' },
	'claude-opus-4.7': { input: '$5', cachedInput: '$0.5', output: '$25', cachedOutput: '$6.25' },
	'claude-opus-4.8': { input: '$5', cachedInput: '$0.5', output: '$25', cachedOutput: '$6.25' },
	'gemini-2.5-pro': { input: '$1.25', cachedInput: '$0.125', output: '$10', cachedOutput: '-' },
	'gemini-3-flash': { input: '$0.5', cachedInput: '$0.05', output: '$3', cachedOutput: '-' },
	'gemini-3.1-pro': { input: '$2', cachedInput: '$0.2', output: '$12', cachedOutput: '-' },
	'gemini-3.5-flash': { input: '$1.5', cachedInput: '$0.15', output: '$9', cachedOutput: '-' },
	'raptor-mini': { input: '$0.25', cachedInput: '$0.025', output: '$2', cachedOutput: '-' },
};

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
					const data = await res.json() as { data?: Array<{
						id: string;
						billing?: { multiplier?: number | string };
						cost?: number | string;
						pricing?: Record<string, number | string | undefined>;
						supportedReasoningEfforts?: string[];
						reasoning?: string[] | string;
					}> };
					if (data.data?.length) {
						return {
							models: data.data.map(m => this.toModelRow(m, m.id)),
							columns: [
								{ key: 'id', header: 'MODEL' },
								{ key: 'inputCost', header: 'IN (CachedIn)' },
								{ key: 'outputCost', header: 'OUT (CachedOut)' },
								{ key: 'reasoning', header: 'REASONING' },
							],
							footnote: this.costFootnote(),
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
			models: models.map(m => this.toModelRow(m, m.name)),
			columns: [
				{ key: 'id', header: 'MODEL' },
				{ key: 'inputCost', header: 'IN (CachedIn)' },
				{ key: 'outputCost', header: 'OUT (CachedOut)' },
				{ key: 'reasoning', header: 'REASONING' },
			],
			footnote: this.costFootnote(),
		};
	}

	private static toModelRow(model: {
		id?: string;
		name?: string;
		billing?: { multiplier?: number | string };
		cost?: number | string;
		pricing?: Record<string, number | string | undefined>;
		supportedReasoningEfforts?: string[];
		reasoning?: string[] | string;
	}, displayName: string) {
		const pricing = this.resolveTokenPricing(model);
		return {
			id: model.id ?? displayName,
			displayName,
			inputCost: this.formatInputCost(pricing),
			outputCost: this.formatOutputCost(pricing),
			reasoning: this.formatReasoningEfforts(model),
			autocompleteLabel: model.id ?? displayName,
		};
	}

	private static resolveTokenPricing(model: {
		id?: string;
		name?: string;
		billing?: { multiplier?: number | string };
		cost?: number | string;
		pricing?: Record<string, number | string | undefined>;
	}): TokenPricing | undefined {
		if (model.cost != null && model.cost !== '') {
			return { input: String(model.cost), cachedInput: '-', output: '-', cachedOutput: '-' };
		}

		const input = model.pricing?.input ?? model.pricing?.prompt;
		const cachedInput = model.pricing?.cachedInput ?? model.pricing?.cached_input ?? model.pricing?.cachedPrompt ?? model.pricing?.cached_prompt;
		const output = model.pricing?.output ?? model.pricing?.completion;
		const cachedOutput = model.pricing?.cachedOutput ?? model.pricing?.cached_output ?? model.pricing?.cacheWrite ?? model.pricing?.cache_write;
		if (input != null || cachedInput != null || output != null || cachedOutput != null) {
			return {
				input: this.formatPrice(input),
				cachedInput: this.formatPrice(cachedInput),
				output: this.formatPrice(output),
				cachedOutput: this.formatPrice(cachedOutput),
			};
		}

		const staticPricing = this.lookupTokenPricing(model.id) ?? this.lookupTokenPricing(model.name);
		if (staticPricing) return staticPricing;

		const multiplier = model.billing?.multiplier;
		if (multiplier != null && multiplier !== '') {
			return { input: `${multiplier}x`, cachedInput: '-', output: '-', cachedOutput: '-' };
		}

		return undefined;
	}

	private static formatInputCost(pricing?: TokenPricing): string {
		if (!pricing) return '-';
		return `${pricing.input} (${pricing.cachedInput})`;
	}

	private static formatOutputCost(pricing?: TokenPricing): string {
		if (!pricing) return '-';
		return `${pricing.output} (${pricing.cachedOutput})`;
	}

	private static formatPrice(value: number | string | undefined): string {
		if (value == null || value === '') return '-';
		if (typeof value === 'number') return `$${value}`;
		return value.startsWith('$') || value === '-' ? value : `$${value}`;
	}

	private static lookupTokenPricing(modelName?: string): TokenPricing | undefined {
		if (!modelName) return undefined;
		const normalized = modelName.toLowerCase().replace(/\s+/g, '-');
		return COPILOT_TOKEN_PRICING[modelName.toLowerCase()] ?? COPILOT_TOKEN_PRICING[normalized];
	}

	private static costFootnote(): string {
		return 'Costs are $/1M tokens. CachedOut is cache-write pricing where the provider publishes it.';
	}

	private static formatReasoningEfforts(model: {
		supportedReasoningEfforts?: string[];
		reasoning?: string[] | string;
	}): string {
		if (Array.isArray(model.supportedReasoningEfforts)) return model.supportedReasoningEfforts.join('/') || '-';
		if (Array.isArray(model.reasoning)) return model.reasoning.join('/') || '-';
		return model.reasoning || '-';
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
		let sentBeforeAttempt = 0;
		let sentAfterAttempt = 0;
		try {
			const prompt = this.buildPrompt(items);
			const attachments = items.flatMap(item => item.attachments ?? []);

			logger.log(`[${this.model}] Sending prompt (attempt ${attempt}):\n${prompt.slice(0, 300)}`);

			this.counter.startRequest(this.model, items.length);
			sentBeforeAttempt = this.counter.getCurrentSentCount();
			try {
				await this.provider.sendPrompt(prompt, { attachments });
			} finally {
				sentAfterAttempt = this.counter.getCurrentSentCount();
				this.counter.finalizeRequest();
			}

			logger.log(`[${this.model}] Processing complete`);
			return 'done';
		} catch (err) {
			const msg = (err as Error).message || '';
			if (sentAfterAttempt > sentBeforeAttempt) {
				logger.log(`[${this.model}] Processing complete`);
				return 'done';
			}
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
