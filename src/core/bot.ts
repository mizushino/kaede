import { Agent } from './agent.js';
import { CopilotClientManager } from './client.js';
import { RequestCounter } from './counter.js';
import type { Messenger } from './messenger.js';
import fs from 'fs';
import path from 'path';
import { writeFile } from 'fs/promises';
import { logger } from './logger.js';

export type SessionScope = 'channel' | 'server';

export abstract class Bot {
  protected readonly workspaceDir: string;
  protected readonly temporaryDir: string;
  protected readonly pluginsDir: string;
  protected readonly model: string;
  protected readonly sessionScope: SessionScope;
  protected readonly clientManager = new CopilotClientManager();
  protected readonly counter: RequestCounter;
  protected sessions = new Map<string, Agent>();
  private processedMessages = new Set<string>();

  constructor() {
    this.workspaceDir = process.env.WORKSPACE_DIR || 'workspace';
    this.temporaryDir = process.env.TEMPORARY_DIR || 'tmp';
    this.pluginsDir = process.env.PLUGINS_DIR || path.join(this.workspaceDir, 'plugins');
    this.model = process.env.COPILOT_MODEL || '';
    this.sessionScope = (process.env.SESSION_SCOPE as SessionScope) || 'channel';
    this.counter = new RequestCounter(this.temporaryDir);
    fs.mkdirSync(this.workspaceDir, { recursive: true });
    fs.mkdirSync(this.temporaryDir, { recursive: true });
    logger.log(`[BOT] Session scope: ${this.sessionScope}`);
  }

  protected abstract createMessenger(channelId: string): Messenger;

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
      agent = new Agent(messenger, this.workspaceDir, this.pluginsDir, this.model, this.clientManager, this.counter, sessionKey);
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

  async shutdown(): Promise<void> {
    logger.log('[BOT] Shutting down...');
    for (const agent of this.sessions.values()) {
      agent.dispose();
    }
    this.sessions.clear();
    this.counter.flush();
    await this.clientManager.shutdown();
    logger.log('[BOT] Disconnected');
  }
}
