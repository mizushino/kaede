import { Agent } from './agent.js';
import { CopilotClientManager } from './client.js';
import type { Messenger } from './messenger.js';
import fs from 'fs';
import path from 'path';
import { writeFile } from 'fs/promises';
import { logger } from './logger.js';

export abstract class Bot {
  protected readonly workspaceDir: string;
  protected readonly temporaryDir: string;
  protected readonly skillsDir: string;
  protected readonly model: string;
  protected readonly clientManager = new CopilotClientManager();
  protected sessions = new Map<string, Agent>();
  private processedMessages = new Set<string>();

  constructor() {
    this.workspaceDir = process.env.WORKSPACE_DIR || 'workspace';
    this.temporaryDir = process.env.TEMPORARY_DIR || 'tmp';
    this.skillsDir = process.env.SKILLS_DIR || path.join(this.workspaceDir, 'skills');
    this.model = process.env.COPILOT_MODEL || '';
    fs.mkdirSync(this.workspaceDir, { recursive: true });
    fs.mkdirSync(this.temporaryDir, { recursive: true });
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

  protected getOrCreateAgent(channelId: string): Agent {
    let agent = this.sessions.get(channelId);
    if (!agent) {
      logger.log(`[BOT] Creating agent (model: ${this.model}) for channel ${channelId}`);
      const messenger = this.createMessenger(channelId);
      agent = new Agent(messenger, this.workspaceDir, this.skillsDir, this.model, this.clientManager);
      this.sessions.set(channelId, agent);
    }
    return agent;
  }

  protected async resetAgent(channelId: string): Promise<Agent | undefined> {
    const agent = this.sessions.get(channelId);
    if (agent) {
      agent.dispose();
      await agent.deleteCliSession();
      this.sessions.delete(channelId);
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
    await this.clientManager.shutdown();
    logger.log('[BOT] Disconnected');
  }
}
