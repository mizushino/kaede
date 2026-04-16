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

const SESSION_TIMEOUT = Number(process.env.SESSION_TIMEOUT_MS) || 3_600_000; // 1 hour
const MAX_RETRIES = Number(process.env.MAX_RETRIES) || 5;
const REASONING_EFFORT = (process.env.REASONING_EFFORT || '') as ReasoningEffort | '';

const truncate = (s: string, n = 120) => s.length > n ? s.slice(0, n) + '…' : s;

export class Agent implements ToolContext {
  model: string;
  messenger: Messenger;
  queue = new Inbox();
  readonly skillLoader: SkillLoader;

  private clientManager: CopilotClientManager;
  private workspaceDir: string;
  private permissionConfig: PermissionConfig;
  private processingPromise: Promise<void> | null = null;

  constructor(messenger: Messenger, workspaceDir: string, model: string, clientManager: CopilotClientManager) {
    this.messenger = messenger;
    this.workspaceDir = workspaceDir;
    this.model = model;
    this.clientManager = clientManager;
    this.permissionConfig = loadPermissionConfig();
    this.skillLoader = new SkillLoader(path.join(workspaceDir, 'skills'));
  }

  private async createFreshSession(): Promise<CopilotSession> {
    const client = await this.clientManager.getClient();
    const channelId = this.messenger.channelId;
    const sessionId = `ch_${channelId}`;

    // Clean up any existing session with this ID
    try { await client.deleteSession(sessionId); } catch { /* may not exist */ }

    // Load skill tools (re-imported each session for hot-reload)
    const skillTools = await this.skillLoader.loadTools(this);

    const session = await client.createSession({
      sessionId,
      model: this.model,
      ...(REASONING_EFFORT ? { reasoningEffort: REASONING_EFFORT } : {}),
      onPermissionRequest: createPermissionHandler(this.messenger, this.permissionConfig),
      onUserInputRequest: async (request) => {
        const { answer, wasFreeform } = await this.messenger.requestUserInput(
          request.question,
          request.choices,
          request.allowFreeform,
        );
        return { answer, wasFreeform };
      },
      tools: [...createTools(this), ...this.skillLoader.createTools(this), ...skillTools],
      systemMessage: {
        content: `You are a helpful AI assistant operating in a chat channel.
Your working directory is ${path.resolve(this.workspaceDir)}.
Use the send_message tool to respond to users. Always respond in the same language as the user's message.
You may reply to a specific message by including the messageId parameter.
The current channel ID is: ${channelId}

You have a self-modifiable skill system (skills dir: ${this.skillLoader.skillsDir}).
Tools: list_skills, read_skill, write_skill, delete_skill, run_skill

After responding, call wait_messages to wait for new messages.`,
      },
    });

    this.setupEventHandlers(session);
    console.log(`[${this.model}] Created session ${sessionId} (${skillTools.length} skill tool(s) loaded)`);
    return session;
  }

  private setupEventHandlers(session: CopilotSession): void {

    session.on('tool.execution_start', (event: any) => {
      const toolName = event?.data?.toolName || '';
      const args = event?.data?.parameters || event?.data?.arguments || event?.data?.args || {};
      const detail = this.formatToolDetail(toolName, args);
      const icon = STATUS_ICON[toolName] ?? '🤔';
      if (icon) {
        const status = truncate(`${icon} ${toolName}${detail}`, 88);
        console.log(`[${this.model}] tool: ${toolName}${detail}`);
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
    console.log(`[${this.model}] Queued message (${this.queue.length} pending) [ch:${this.messenger.channelId}]`);

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

        console.log(`[${this.model}] Processing ${items.length} message(s)`);
        await this.sendMessages(items);
      }
    } catch (err) {
      console.error(`[${this.model}] Processing error:`, err);
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
        const session = await this.createFreshSession();

        const prompt = this.buildPrompt(items);
        const imageAttachments = items
          .flatMap(item => item.attachments)
          .map(filePath => ({ type: 'file' as const, path: filePath }));

        console.log(`[${this.model}] Sending prompt (attempt ${attempt}):\n${prompt.slice(0, 300)}`);

        await session.sendAndWait({
          prompt,
          ...(imageAttachments.length > 0 ? { attachments: imageAttachments } : {}),
        }, SESSION_TIMEOUT);

        console.log(`[${this.model}] Processing complete`);
        return;
      } catch (err) {
        const msg = (err as Error).message || '';
        console.log(`[${this.model}] Attempt ${attempt}/${MAX_RETRIES} failed: ${msg.slice(0, 120)}`);

        // Session timeout = normal session expiry, not an error
        if (msg.includes('Timeout') && msg.includes('session.idle')) {
          console.log(`[${this.model}] Session expired after timeout, ending normally`);
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
            console.error(`[${this.model}] Connection failed after ${MAX_RETRIES} retries, message dropped`);
          } else {
            console.error(`[${this.model}] Error:`, err);
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
    this.queue.abort();
    this.messenger.stopTyping();
    this.messenger.clearStatus();
  }
}
