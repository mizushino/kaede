import { CopilotSession } from '@github/copilot-sdk';
import path from 'path';

type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
import { CopilotClientManager } from './client.js';
import { createTools, ToolContext } from './tools.js';
import { SkillLoader } from './skills.js';
import { Inbox, QueuedMessage, IncomingMessage } from './inbox.js';
import type { Messenger } from './messenger.js';
import { loadPermissionConfig, createPermissionHandler, type PermissionConfig } from './permissions.js';
import { STATUS_ICON } from './status.js';
import { logger } from './logger.js';

const SESSION_TIMEOUT = Number(process.env.SESSION_TIMEOUT_MS) || 3_600_000; // 1 hour
const MAX_RETRIES = Number(process.env.MAX_RETRIES) || 5;
const REASONING_EFFORT = (process.env.REASONING_EFFORT || '') as ReasoningEffort | '';

const truncate = (s: string, n = 120) => s.length > n ? s.slice(0, n) + '…' : s;

export class Agent implements ToolContext {
  model: string;
  reasoningEffort: ReasoningEffort | '';
  messenger: Messenger;
  queue = new Inbox();
  readonly skillLoader: SkillLoader;

  private clientManager: CopilotClientManager;
  private workspaceDir: string;
  private permissionConfig: PermissionConfig;
  private processingPromise: Promise<void> | null = null;
  private currentSession: CopilotSession | null = null;
  private resumeOnNextMessage = false;

  constructor(messenger: Messenger, workspaceDir: string, skillsDir: string, model: string, clientManager: CopilotClientManager) {
    this.messenger = messenger;
    this.workspaceDir = workspaceDir;
    this.model = model;
    this.reasoningEffort = REASONING_EFFORT;
    this.clientManager = clientManager;
    this.permissionConfig = loadPermissionConfig();
    this.skillLoader = new SkillLoader(skillsDir);
  }

  async setModel(model: string, reasoningEffort?: ReasoningEffort | ''): Promise<void> {
    this.model = model;
    if (reasoningEffort !== undefined) this.reasoningEffort = reasoningEffort;
    if (this.currentSession) {
      // Disconnect without deleting — session history on disk is preserved for resumeSession()
      try { await this.currentSession.disconnect(); } catch { /* ignore */ }
      this.currentSession = null;
      this.resumeOnNextMessage = true;
    }
  }

  private buildSessionConfig() {
    const channelId = this.messenger.channelId;
    return {
      model: this.model,
      ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
      onPermissionRequest: createPermissionHandler(this.messenger, this.permissionConfig),
      onUserInputRequest: async (request: { question: string; choices?: string[]; allowFreeform?: boolean }) => {
        const { answer, wasFreeform } = await this.messenger.requestUserInput(
          request.question,
          request.choices,
          request.allowFreeform,
        );
        return { answer, wasFreeform };
      },
      tools: [...createTools(this), ...this.skillLoader.createTools(this)],
      systemMessage: {
        content: `You are a helpful AI assistant operating in a chat channel.
Your working directory is ${path.resolve(this.workspaceDir)}.
Use the send_message tool to respond to users. Always respond in the same language as the user's message.
You may reply to a specific message by including the messageId parameter.
The current channel ID is: ${channelId}

You have a self-modifiable skill system (skills dir: ${this.skillLoader.skillsDir}).
Tools: list_skills, read_skill, write_skill, delete_skill, run_skill

IMPORTANT RULES:
- ALWAYS use the send_message tool to send responses. Never output text directly without calling send_message.
- ALWAYS call wait_messages after every response, even if you have nothing to say. This keeps you online and ready for the next message.
- Do not end the session without calling wait_messages.`,
      },
    };
  }

  private async createFreshSession(): Promise<CopilotSession> {
    const client = await this.clientManager.getClient();
    const channelId = this.messenger.channelId;
    const sessionId = `ch_${channelId}`;

    // Load skill tools (re-imported each session for hot-reload)
    const skillTools = await this.skillLoader.loadTools(this);
    const config = this.buildSessionConfig();
    config.tools = [...config.tools, ...skillTools];

    // Try to resume an existing session first (preserves history across restarts)
    try {
      const session = await client.resumeSession(sessionId, config);
      this.setupEventHandlers(session);
      this.currentSession = session;
      logger.log(`[${this.model}] Resumed existing session ${sessionId} (${skillTools.length} skill tool(s) loaded)`);
      return session;
    } catch {
      // No existing session — create fresh
    }

    try { await client.deleteSession(sessionId); } catch { /* may not exist */ }
    const session = await client.createSession({ sessionId, ...config });
    this.setupEventHandlers(session);
    this.currentSession = session;
    logger.log(`[${this.model}] Created session ${sessionId} (${skillTools.length} skill tool(s) loaded)`);
    return session;
  }

  private async resumeSession(): Promise<CopilotSession> {
    const client = await this.clientManager.getClient();
    const sessionId = `ch_${this.messenger.channelId}`;

    const skillTools = await this.skillLoader.loadTools(this);
    const config = this.buildSessionConfig();
    config.tools = [...config.tools, ...skillTools];

    const session = await client.resumeSession(sessionId, config);
    this.setupEventHandlers(session);
    this.currentSession = session;
    this.resumeOnNextMessage = false;
    logger.log(`[${this.model}] Resumed session ${sessionId} with new model`);
    return session;
  }

  private setupEventHandlers(session: CopilotSession): void {

    session.on('tool.execution_start', (event: any) => {
      const toolName = event?.data?.toolName || '';
      const args = event?.data?.parameters || event?.data?.arguments || event?.data?.args || {};
      const detail = this.formatToolDetail(toolName, args);
      const icon = STATUS_ICON[toolName] ?? '🤔';
      logger.log(`[${this.model}] tool: ${toolName}${detail}`);
      if (icon && toolName !== 'send_message') {
        const status = truncate(`${icon} ${toolName}${detail}`, 88);
        this.messenger.setStatus(status);
      }
    });

    session.on('session.idle', () => {
      this.messenger.clearStatus();
      this.messenger.stopTyping();
    });
  }

  private formatToolDetail(tool: string, args: Record<string, any>): string {
    const val = (key: string) => args[key] ? ` | ${truncate(String(args[key]))}` : '';
    switch (tool) {
      case 'bash':           return val('command');
      case 'view':           return val('path');
      case 'create':         return val('path');
      case 'edit':           return val('path');
      case 'glob':           return val('pattern');
      case 'grep':           return val('pattern');
      case 'web_fetch':      return val('url');
      case 'write_skill':    return val('filename');
      case 'read_skill':     return val('filename');
      case 'delete_skill':   return val('filename');
      case 'run_skill':      return ` | ${args.filename || ''}:${args.tool || ''}`;
      case 'send_message':   return args.content ? `\n${truncate(String(args.content), 300)}` : '';
      case 'get_messages':   return val('channelId');
      default:               return Object.keys(args).length ? ` | ${truncate(JSON.stringify(args))}` : '';
    }
  }

  async processMessage(message: IncomingMessage, attachments: string[], files: string[] = []): Promise<void> {
    this.queue.push({ message, attachments, files });
    logger.log(`[${this.model}] Queued message (${this.queue.length} pending) [ch:${this.messenger.channelId}]`);

    // If already processing, the AI will pick up queued messages via wait_messages tool
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
      const gen = this.clientManager.generation;
      try {
        const session = this.resumeOnNextMessage
          ? await this.resumeSession()
          : await this.createFreshSession();

        const prompt = this.buildPrompt(items);
        const imageAttachments = items
          .flatMap(item => item.attachments)
          .map(filePath => ({ type: 'file' as const, path: filePath }));

        logger.log(`[${this.model}] Sending prompt (attempt ${attempt}):\n${prompt.slice(0, 300)}`);

        await session.sendAndWait({
          prompt,
          ...(imageAttachments.length > 0 ? { attachments: imageAttachments } : {}),
        }, SESSION_TIMEOUT);

        this.currentSession = null;
        logger.log(`[${this.model}] Processing complete`);
        return;
      } catch (err) {
        this.currentSession = null;
        const msg = (err as Error).message || '';
        logger.log(`[${this.model}] Attempt ${attempt}/${MAX_RETRIES} failed: ${msg.slice(0, 120)}`);

        // Session timeout = normal session expiry, not an error
        if (msg.includes('Timeout') && msg.includes('session.idle')) {
          logger.log(`[${this.model}] Session expired after timeout, ending normally`);
          return;
        }

        // Reset client if connection-level error (only once per generation)
        if (msg.includes('Connection is closed') || msg.includes('ConnectionError') || msg.includes('Session not found')) {
          if (this.clientManager.generation === gen) {
            this.clientManager.invalidate();
          }
          if (attempt < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, attempt * 2000));
            continue;
          }
        }

        // Final failure
        if (attempt === MAX_RETRIES) {
          const isTransient = msg.includes('Connection is closed') || msg.includes('ConnectionError');
          if (isTransient) {
            logger.error(`[${this.model}] Connection failed after ${MAX_RETRIES} retries, message dropped`);
          } else {
            logger.error(`[${this.model}] Error:`, err);
            await this.messenger.sendError(msg);
          }
        }
      }
    }
  }

  private buildPrompt(items: QueuedMessage[]): string {
    const channelId = this.messenger.channelId;
    const messageData = items.map(item => ({
      id: item.message.id,
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

Important: Use send_message to respond. You may reply to a specific message by including its messageId. Only respond to messages that are direct replies or mentions to you. Do not respond to any other messages.
send_message
channelId:"${channelId}"
messageId: (Optional - use the ID of the message you want to reply to from the JSON above)`;
  }

  // --- Lifecycle ---

  dispose(): void {
    if (this.currentSession) {
      this.currentSession.disconnect().catch(() => {});
      this.currentSession = null;
    }
    this.queue.abort();
    this.messenger.stopTyping();
    this.messenger.clearStatus();
  }

  async deleteCliSession(): Promise<void> {
    const client = await this.clientManager.getClient();
    const sessionId = `ch_${this.messenger.channelId}`;
    try { await client.deleteSession(sessionId); } catch { /* may not exist */ }
  }
}
