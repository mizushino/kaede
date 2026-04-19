import { Agent } from './agent.js';
import { CopilotClientManager } from './client.js';
import { RequestCounter } from './counter.js';
import { Scheduler } from './scheduler.js';
import type { Messenger } from './messenger.js';
import fs from 'fs';
import path from 'path';
import { writeFile } from 'fs/promises';
import { logger } from './logger.js';

export type SessionScope = 'channel' | 'server';

export abstract class Bot {
  protected readonly workspaceDir: string;
  protected readonly temporaryDir: string;
  protected readonly functionsDir: string;
  protected readonly model: string;
  protected readonly sessionScope: SessionScope;
  protected readonly clientManager = new CopilotClientManager();
  protected readonly counter: RequestCounter;
  protected readonly scheduler: Scheduler;
  protected sessions = new Map<string, Agent>();
  private processedMessages = new Set<string>();

  constructor() {
    this.workspaceDir = process.env.WORKSPACE_DIR || 'workspace';
    this.temporaryDir = process.env.TEMPORARY_DIR || 'tmp';
    this.functionsDir = process.env.FUNCTIONS_DIR || path.join(this.workspaceDir, 'functions');
    this.model = process.env.COPILOT_MODEL || '';
    this.sessionScope = (process.env.SESSION_SCOPE as SessionScope) || 'channel';
    this.counter = new RequestCounter(this.temporaryDir);
    this.scheduler = new Scheduler(
      path.join(this.workspaceDir, 'schedules.json'),
      (entry) => this.onScheduleFire(entry),
    );
    fs.mkdirSync(this.workspaceDir, { recursive: true });
    fs.mkdirSync(this.temporaryDir, { recursive: true });
    logger.log(`[BOT] Session scope: ${this.sessionScope}`);
  }

  protected abstract createMessenger(channelId: string): Messenger;
  protected abstract getBotId(): string;

  protected isDuplicate(messageId: string): boolean {
    if (this.processedMessages.has(messageId)) return true;
    this.processedMessages.add(messageId);
    if (this.processedMessages.size > 1000) {
      this.processedMessages = new Set([...this.processedMessages].slice(-500));
    }
    return false;
  }

  protected async downloadAttachment(url: string, destPath: string): Promise<void> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(destPath, buffer);
  }

  protected resolveSessionKey(channelId: string, guildId?: string): string {
    return this.sessionScope === 'server' && guildId ? guildId : channelId;
  }

  protected getOrCreateAgent(channelId: string, guildId?: string): Agent {
    const sessionKey = this.resolveSessionKey(channelId, guildId);
    let agent = this.sessions.get(sessionKey);
    if (!agent) {
      logger.log(`[BOT] Creating agent (model: ${this.model}, scope: ${this.sessionScope}) for ${this.sessionScope === 'server' ? 'server' : 'channel'} ${sessionKey}`);
      const messenger = this.createMessenger(channelId);
      agent = new Agent(messenger, this.workspaceDir, this.functionsDir, this.model, this.clientManager, this.counter, this.scheduler, sessionKey);
      this.sessions.set(sessionKey, agent);
    } else if (agent.messenger.channelId !== channelId) {
      // Update active channel for typing indicators and status
      agent.messenger.channelId = channelId;
    }
    return agent;
  }

  protected async resetAgent(channelId: string, guildId?: string): Promise<Agent | undefined> {
    const sessionKey = this.resolveSessionKey(channelId, guildId);
    const agent = this.sessions.get(sessionKey);
    if (agent) {
      agent.dispose();
      await agent.deleteCliSession();
      this.sessions.delete(sessionKey);
    }
    return agent;
  }

  abstract start(): Promise<void>;

  /** Called by Scheduler when a cron job fires. */
  private async onScheduleFire(entry: import('./scheduler.js').ScheduleEntry): Promise<void> {
    logger.log(`[BOT] Schedule fired: "${entry.id}" → ch:${entry.channelId}`);
    const agent = this.getOrCreateAgent(entry.channelId, entry.guildId);
    const incoming = {
      id: `schedule_${entry.id}_${Date.now()}`,
      channelId: entry.channelId,
      author: 'scheduler',
      content: `<@${this.getBotId()}> ${entry.prompt}`,
    };
    await agent.processMessage(incoming, [], []);
  }

  async shutdown(): Promise<void> {
    logger.log('[BOT] Shutting down...');
    this.scheduler.stop();
    for (const agent of this.sessions.values()) {
      agent.dispose();
    }
    this.sessions.clear();
    this.counter.flush();
    await this.clientManager.shutdown();
    logger.log('[BOT] Disconnected');
  }
}
