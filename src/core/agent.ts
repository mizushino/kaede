import { CopilotSession } from '@github/copilot-sdk';
import type { ElicitationContext, ElicitationResult, ElicitationFieldValue } from '@github/copilot-sdk';
import path from 'path';

type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
import { CopilotClientManager } from './client.js';
import { createTools, ToolContext } from './tools.js';
import { PluginLoader } from './plugins.js';
import { Inbox, QueuedMessage, IncomingMessage } from './inbox.js';
import type { Messenger } from './messenger.js';
import { loadPermissionConfig, createPermissionHandler, type PermissionConfig } from './permissions.js';
import { STATUS_ICON } from './status.js';
import { logger } from './logger.js';
import type { RequestCounter } from './counter.js';
import type { Scheduler } from './scheduler.js';

const SESSION_TIMEOUT = Number(process.env.SESSION_TIMEOUT_MS) || 10_800_000; // 3 hour
const MAX_RETRIES = Number(process.env.MAX_RETRIES) || 5;
const REASONING_EFFORT = (process.env.REASONING_EFFORT || '') as ReasoningEffort | '';

const truncate = (s: string, n = 120) => s.length > n ? s.slice(0, n) + '…' : s;

export class Agent implements ToolContext {
  model: string;
  reasoningEffort: ReasoningEffort | '';
  messenger: Messenger;
  queue = new Inbox();
  readonly pluginLoader: PluginLoader;
  readonly counter: RequestCounter;
  readonly scheduler: Scheduler;
  readonly sessionKey: string;

  private clientManager: CopilotClientManager;
  private workspaceDir: string;
  private permissionConfig: PermissionConfig;
  private processingPromise: Promise<void> | null = null;
  private currentSession: CopilotSession | null = null;
  private resumeOnNextMessage = false;

  constructor(messenger: Messenger, workspaceDir: string, pluginsDir: string, model: string, clientManager: CopilotClientManager, counter: RequestCounter, scheduler: Scheduler, sessionKey?: string) {
    this.messenger = messenger;
    this.workspaceDir = workspaceDir;
    this.model = model;
    this.reasoningEffort = REASONING_EFFORT;
    this.clientManager = clientManager;
    this.permissionConfig = loadPermissionConfig();
    this.pluginLoader = new PluginLoader(pluginsDir);
    this.counter = counter;
    this.scheduler = scheduler;
    this.sessionKey = sessionKey ?? messenger.channelId;
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
      workingDirectory: path.resolve(this.workspaceDir),
      enableConfigDiscovery: true,
      ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
      onPermissionRequest: createPermissionHandler(this.messenger, this.permissionConfig),
      onElicitationRequest: async (context: ElicitationContext): Promise<ElicitationResult> => {
        const { message, requestedSchema } = context;
        const fields = requestedSchema?.properties ?? {};
        const requiredFields = requestedSchema?.required ?? [];
        const fieldNames = Object.keys(fields);

        if (fieldNames.length === 0) {
          // Simple confirmation
          const confirmed = await this.messenger.requestApproval(message, Number(process.env.USER_RESPONSE_TIMEOUT_MS) || 300_000);
          return { action: confirmed ? 'accept' : 'decline' };
        }

        const content: Record<string, ElicitationFieldValue> = {};
        for (const fieldName of fieldNames) {
          const field = fields[fieldName];
          const title = field.title ?? fieldName;
          const desc = field.description ? `\n${field.description}` : '';
          const isRequired = requiredFields.includes(fieldName);
          const reqLabel = isRequired ? ' (必須)' : ' (任意)';

          if (field.type === 'boolean') {
            const confirmed = await this.messenger.requestApproval(
              `${message}\n\n**${title}**${reqLabel}${desc}`, Number(process.env.USER_RESPONSE_TIMEOUT_MS) || 300_000
            );
            content[fieldName] = confirmed;
          } else if (field.type === 'string' && 'enum' in field && field.enum) {
            const { answer } = await this.messenger.requestUserInput(
              `${message}\n\n**${title}**${reqLabel}${desc}`,
              field.enum, true
            );
            if (!answer && isRequired) return { action: 'cancel' };
            content[fieldName] = answer || (field.default as string) || '';
          } else if (field.type === 'string' && 'oneOf' in field && field.oneOf) {
            const choices = field.oneOf.map((o: { const: string; title: string }) => o.title);
            const { answer } = await this.messenger.requestUserInput(
              `${message}\n\n**${title}**${reqLabel}${desc}`,
              choices, true
            );
            if (!answer && isRequired) return { action: 'cancel' };
            const selected = field.oneOf.find((o: { const: string; title: string }) => o.title === answer);
            content[fieldName] = selected?.const ?? answer ?? (field.default as string) ?? '';
          } else {
            // string, number — freeform input
            const { answer } = await this.messenger.requestUserInput(
              `${message}\n\n**${title}**${reqLabel}${desc}`
            );
            if (!answer && isRequired) return { action: 'cancel' };
            if (field.type === 'number' || field.type === 'integer') {
              content[fieldName] = Number(answer) || 0;
            } else {
              content[fieldName] = answer || (field.default as string) || '';
            }
          }
        }

        return { action: 'accept', content };
      },
      onUserInputRequest: async (request: { question: string; choices?: string[]; allowFreeform?: boolean }) => {
        const { answer, wasFreeform } = await this.messenger.requestUserInput(
          request.question,
          request.choices,
          request.allowFreeform,
        );
        return { answer, wasFreeform };
      },
      tools: [...createTools(this), ...this.pluginLoader.createTools(this)],
      systemMessage: {
        content: `You are a helpful AI assistant operating in a chat channel.
Your working directory is ${path.resolve(this.workspaceDir)}.
Use the send_message tool to respond to users. Always respond in the same language as the user's message.
You may reply to a specific message by including the messageId parameter.
The current channel ID is: ${channelId}

You have a self-modifiable plugin system (plugins dir: ${this.pluginLoader.pluginsDir}).
Tools: list_plugins, read_plugin, write_plugin, delete_plugin, run_plugin

You can manage scheduled tasks (cron-based, timezone: Asia/Tokyo).
Tools: schedule_add, schedule_list, schedule_remove, schedule_toggle
When users ask to schedule something, convert their request to a cron expression and use schedule_add.

IMPORTANT RULES:
- ALWAYS use the send_message tool to send responses. Never output text directly without calling send_message.
- ALWAYS call wait_messages after every response, even if you have nothing to say. This keeps you online and ready for the next message.
- Do not end the session without calling wait_messages.`,
      },
    };
  }

  private async createFreshSession(): Promise<CopilotSession> {
    const client = await this.clientManager.getClient();
    const sessionId = `session_${this.sessionKey}`;

    // Load plugin tools (re-imported each session for hot-reload)
    const pluginTools = await this.pluginLoader.loadTools(this);
    const config = this.buildSessionConfig();
    config.tools = [...config.tools, ...pluginTools];

    // Try to resume an existing session first (preserves history across restarts)
    try {
      const session = await client.resumeSession(sessionId, config);
      this.setupEventHandlers(session);
      this.currentSession = session;
      logger.log(`[${this.model}] Resumed existing session ${sessionId} (${pluginTools.length} plugin tool(s) loaded)`);
      return session;
    } catch {
      // No existing session — create fresh
    }

    try { await client.deleteSession(sessionId); } catch { /* may not exist */ }
    const session = await client.createSession({ sessionId, ...config });
    this.setupEventHandlers(session);
    this.currentSession = session;
    logger.log(`[${this.model}] Created session ${sessionId} (${pluginTools.length} plugin tool(s) loaded)`);
    return session;
  }

  private async resumeSession(): Promise<CopilotSession> {
    const client = await this.clientManager.getClient();
    const sessionId = `session_${this.sessionKey}`;

    const pluginTools = await this.pluginLoader.loadTools(this);
    const config = this.buildSessionConfig();
    config.tools = [...config.tools, ...pluginTools];

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
      case 'write_plugin':    return val('filename');
      case 'read_plugin':     return val('filename');
      case 'delete_plugin':   return val('filename');
      case 'run_plugin':      return ` | ${args.filename || ''}:${args.tool || ''}`;
      case 'send_message':   return args.content ? `\n${truncate(String(args.content), 300)}` : '';
      case 'get_messages':   return val('channelId');
      case 'schedule_add':   return ` | ${args.cron || ''} → ${args.description || truncate(args.prompt || '', 60)}`;
      case 'schedule_remove': return val('id');
      case 'schedule_toggle': return val('id');
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

        this.counter.incrementSendAndWait(this.model);
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
    const sessionId = `session_${this.sessionKey}`;
    try { await client.deleteSession(sessionId); } catch { /* may not exist */ }
  }
}
