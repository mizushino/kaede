import { CopilotSession } from '@github/copilot-sdk';
import type { ElicitationContext, ElicitationResult } from '@github/copilot-sdk';
import path from 'path';
import type { CopilotClientManager } from '../core/client.js';
import { FunctionLoader } from '../core/functions.js';
import { createTools, type ToolContext } from '../core/tools.js';
import { createPermissionHandler, type PermissionConfig } from '../core/permissions.js';
import { logger } from '../core/logger.js';
import type { Inbox } from '../core/inbox.js';
import type { RequestCounter } from '../core/counter.js';
import type { Scheduler } from '../core/scheduler.js';
import { BaseProvider } from './provider.js';
import type { ProviderContext, ProviderOptions } from './provider.js';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type CopilotSendErrorAction = 'retry' | 'stop' | 'connection' | 'fail';

const SESSION_TIMEOUT = Number(process.env.SESSION_TIMEOUT_MS) || 10_800_000;
const USER_RESPONSE_TIMEOUT = Number(process.env.USER_RESPONSE_TIMEOUT_MS) || 300_000;
export const DEFAULT_REASONING_EFFORT = (process.env.REASONING_EFFORT || '') as ReasoningEffort | '';

export interface CopilotProviderContext extends ProviderContext {
	clientManager: CopilotClientManager;
	functionLoader: FunctionLoader;
	permissionConfig: PermissionConfig;
	botUserId: string;
	queue: Inbox;
	counter: RequestCounter;
	scheduler: Scheduler;
	getModel(): string;
	getReasoningEffort(): ReasoningEffort | '';
}

export class CopilotCodeProvider extends BaseProvider {
	readonly name = 'copilot';

	private currentSession: CopilotSession | null = null;
	private resumeOnNextMessage = false;
	private activeTurnDeadlineMs: number | null = null;

	constructor(protected readonly context: CopilotProviderContext) {
		super(context);
	}

	protected getDisplayName(): string {
		return 'Copilot SDK';
	}

	async setModel(): Promise<void> {
		if (this.currentSession) {
			try { await this.currentSession.disconnect(); } catch {}
			this.currentSession = null;
			this.activeTurnDeadlineMs = null;
			this.resumeOnNextMessage = true;
		}
	}

	getRemainingTurnTimeMs(): number | null {
		if (this.activeTurnDeadlineMs == null) return null;
		return Math.max(0, this.activeTurnDeadlineMs - Date.now());
	}

	async sendPrompt(prompt: string, options?: ProviderOptions): Promise<void> {
		const session = this.resumeOnNextMessage
			? await this.resumeSession()
			: await this.createFreshSession();

		const imageAttachments = (options?.attachments ?? []).map(filePath => ({ type: 'file' as const, path: filePath }));

		this.context.messenger.setStatus(`${this.getIcon()} ${this.getDisplayName()} 応答生成中...`);
		const turnDeadlineMs = Date.now() + SESSION_TIMEOUT;
		this.activeTurnDeadlineMs = turnDeadlineMs;

		try {
			await session.sendAndWait({
				prompt,
				...(imageAttachments.length > 0 ? { attachments: imageAttachments } : {}),
			}, SESSION_TIMEOUT);
		} finally {
			if (this.activeTurnDeadlineMs === turnDeadlineMs) {
				this.activeTurnDeadlineMs = null;
			}
		}
	}

	async handleSendError(error: Error): Promise<CopilotSendErrorAction> {
		const message = error.message || '';

		if (message.includes('Timeout') && message.includes('session.idle')) {
			logger.log(`[${this.context.getModel()}] Session expired after timeout, ending normally`);
			return 'stop';
		}

		if (message.includes('No tool output found for function call')) {
			logger.log(`[${this.context.getModel()}] Discarding corrupted session after interrupted tool call`);
			await this.discardSession();
			return 'retry';
		}

		if (message.includes('Connection is closed') || message.includes('ConnectionError') || message.includes('Session not found')) {
			this.context.clientManager.invalidate();
			this.currentSession = null;
			this.activeTurnDeadlineMs = null;
			return 'connection';
		}

		return 'fail';
	}

	dispose(): void {
		this.activeTurnDeadlineMs = null;
		this.disconnectCurrentSession();
		super.dispose();
	}

	async deleteSession(): Promise<void> {
		const client = await this.context.clientManager.getClient();
		const sessionId = this.getSessionId();
		try { await client.deleteSession(sessionId); } catch {}
	}

	private getSessionId(): string {
		return `session_${this.context.sessionKey}`;
	}

	private disconnectCurrentSession(): void {
		if (!this.currentSession) return;
		void this.currentSession.disconnect().catch(() => {});
		this.currentSession = null;
	}

	private async discardSession(): Promise<void> {
		const sessionId = this.getSessionId();
		this.disconnectCurrentSession();
		this.activeTurnDeadlineMs = null;
		this.resumeOnNextMessage = false;

		const client = await this.context.clientManager.getClient();
		try { await client.deleteSession(sessionId); } catch {}
	}

	private buildProviderConfig() {
		const baseUrl = process.env.COPILOT_PROVIDER_BASE_URL;
		if (!baseUrl) return undefined;
		const type = (process.env.COPILOT_PROVIDER_TYPE as 'openai' | 'azure' | 'anthropic') || 'openai';
		return {
			type,
			baseUrl,
			...(process.env.COPILOT_PROVIDER_API_KEY ? { apiKey: process.env.COPILOT_PROVIDER_API_KEY } : {}),
		};
	}

	private buildSessionConfig() {
		const channelId = this.context.messenger.channelId;
		const provider = this.buildProviderConfig();
		const reasoningEffort = this.context.getReasoningEffort();
		const maxContextWindowTokens = readPositiveIntegerEnv('COPILOT_MAX_CONTEXT_WINDOW_TOKENS');
		const bgCompactionThreshold = readThresholdEnv('COPILOT_BACKGROUND_COMPACTION_THRESHOLD');
		const bufferExhaustionThreshold = readThresholdEnv('COPILOT_BUFFER_EXHAUSTION_THRESHOLD');

		const modelCapabilities = maxContextWindowTokens
			? { limits: { max_context_window_tokens: maxContextWindowTokens } }
			: undefined;

		const infiniteSessions =
			bgCompactionThreshold !== undefined || bufferExhaustionThreshold !== undefined
				? {
						...(bgCompactionThreshold !== undefined ? { backgroundCompactionThreshold: bgCompactionThreshold } : {}),
						...(bufferExhaustionThreshold !== undefined ? { bufferExhaustionThreshold } : {}),
					}
				: undefined;

		return {
			model: this.context.getModel(),
			workingDirectory: path.resolve(this.context.workspaceDir),
			enableConfigDiscovery: true,
			...(provider ? { provider } : {}),
			...(reasoningEffort ? { reasoningEffort } : {}),
			...(modelCapabilities ? { modelCapabilities } : {}),
			...(infiniteSessions ? { infiniteSessions } : {}),
			onPermissionRequest: createPermissionHandler(this.context.messenger, this.context.permissionConfig),
			onElicitationRequest: async (context: ElicitationContext): Promise<ElicitationResult> => {
				const { message, requestedSchema } = context;
				const outcome = await this.runElicitation(message, requestedSchema ?? {}, USER_RESPONSE_TIMEOUT);
				if (outcome.action === 'accept') {
					return { action: 'accept', content: outcome.content };
				}
				return { action: outcome.action };
			},
			onUserInputRequest: async (request: { question: string; choices?: string[]; allowFreeform?: boolean }) => {
				const { answer, wasFreeform } = await this.context.messenger.requestUserInput(
					request.question,
					request.choices,
					request.allowFreeform,
				);
				return { answer, wasFreeform };
			},
			tools: [...createTools(this.buildToolContext()), ...this.context.functionLoader.createTools(this.buildToolContext())],
			systemMessage: {
				content: `You are a helpful AI assistant operating in a chat channel.
Your working directory is ${path.resolve(this.context.workspaceDir)}.
Use the send_message tool to respond to users. Always respond in the same language as the user's message.
You may reply to a specific message by including the messageId parameter.
The current channel ID is: ${channelId}
${this.context.botUserId ? `Your Discord user ID is: ${this.context.botUserId}` : ''}

You have a self-modifiable function system (functions dir: ${this.context.functionLoader.functionsDir}).
Tools: list_funcs, read_func, write_func, delete_func, run_func

You can manage scheduled tasks (cron-based, timezone: Asia/Tokyo).
Tools: schedule_add, schedule_list, schedule_remove, schedule_toggle
When users ask to schedule something, convert their request to a cron expression and use schedule_add.

IMPORTANT RULES:
- ALWAYS use the send_message tool to send responses. Never output text directly without calling send_message.
- When you need clarification or want the user to choose from options, use the built-in user input flow instead of only describing a question in plain text.
- ALWAYS call wait_messages after every response, even if you have nothing to say. This keeps you online and ready for the next message.
- Do not end the session without calling wait_messages.`,
			},
		};
	}

	private async buildFullConfig() {
		const fnTools = await this.context.functionLoader.loadTools(this.buildToolContext());
		const config = this.buildSessionConfig();
		config.tools = [...config.tools, ...fnTools];
		return { config, fnTools };
	}

	private buildToolContext(): ToolContext {
		return {
			model: this.context.getModel(),
			queue: this.context.queue,
			messenger: this.context.messenger,
			counter: this.context.counter,
			scheduler: this.context.scheduler,
			getRemainingTurnTimeMs: () => this.getRemainingTurnTimeMs(),
		};
	}

	private async createFreshSession(): Promise<CopilotSession> {
		this.disconnectCurrentSession();

		const client = await this.context.clientManager.getClient();
		const sessionId = this.getSessionId();
		const { config, fnTools } = await this.buildFullConfig();

		try {
			const session = await client.resumeSession(sessionId, config);
			this.setupEventHandlers(session);
			this.currentSession = session;
			logger.log(`[${this.context.getModel()}] Resumed existing session ${sessionId} (${fnTools.length} function tool(s) loaded)`);
			return session;
		} catch (error) {
			logger.log(`[${this.context.getModel()}] Could not resume session ${sessionId}: ${(error as Error).message?.slice(0, 100) || 'unknown'}`);
		}

		try { await client.deleteSession(sessionId); } catch {}
		const session = await client.createSession({ sessionId, ...config });
		this.setupEventHandlers(session);
		this.currentSession = session;
		logger.log(`[${this.context.getModel()}] Created session ${sessionId} (${fnTools.length} function tool(s) loaded)`);
		return session;
	}

	private async resumeSession(): Promise<CopilotSession> {
		const client = await this.context.clientManager.getClient();
		const sessionId = this.getSessionId();
		const { config } = await this.buildFullConfig();

		const session = await client.resumeSession(sessionId, config);
		this.setupEventHandlers(session);
		this.currentSession = session;
		this.resumeOnNextMessage = false;
		logger.log(`[${this.context.getModel()}] Resumed session ${sessionId} with new model`);
		return session;
	}

	private setupEventHandlers(session: CopilotSession): void {
		session.on('tool.execution_start', (event: any) => {
			const toolName = event?.data?.toolName || '';
			const args = (event?.data?.parameters || event?.data?.arguments || event?.data?.args || {}) as Record<string, unknown>;
			const detail = this.formatToolDetail(toolName, args);
			logger.log(`[${this.context.getModel()}] tool: ${toolName}${detail ? ` | ${detail}` : ''}`);
			if (toolName !== 'send_message') {
				this.context.messenger.setStatus(this.formatToolStatus(toolName, detail || undefined));
			}
		});

		session.on('session.idle', () => {
			this.context.messenger.clearStatus();
			this.context.messenger.stopTyping();
		});
	}
}

function readPositiveIntegerEnv(primary: string, legacy?: string): number | undefined {
	const raw = process.env[primary] ?? (legacy ? process.env[legacy] : undefined);
	if (!raw) return undefined;

	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		logger.log(`[Agent] Ignoring ${primary} because it must be a positive integer: ${raw}`);
		return undefined;
	}

	return value;
}

function readThresholdEnv(primary: string, legacy?: string): number | undefined {
	const raw = process.env[primary] ?? (legacy ? process.env[legacy] : undefined);
	if (!raw) return undefined;

	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		logger.log(`[Agent] Ignoring ${primary} because it must be a number between 0 and 1 inclusive: ${raw}`);
		return undefined;
	}

	return value;
}