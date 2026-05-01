import { CopilotAgent } from '../providers/index.js';
import { ClaudeAgent } from '../providers/index.js';
import type { ReasoningEffort } from '../providers/provider.js';
import { CopilotClientManager } from './client.js';
import { RequestCounter } from './counter.js';
import { Scheduler } from './scheduler.js';
import type { Messenger } from './messenger.js';
import fs from 'fs';
import path from 'path';
import { writeFile } from 'fs/promises';
import { logger } from './logger.js';

export type SessionScope = 'channel' | 'server';
export type AgentProviderType = 'copilot' | 'claude';

const DEFAULT_PROVIDER: AgentProviderType = 'copilot';
const PROVIDER_MODEL_ENV: Record<AgentProviderType, string> = {
  copilot: 'COPILOT_MODEL',
  claude: 'CLAUDE_MODEL',
};

export interface Agent {
  model: string;
  reasoningEffort?: ReasoningEffort | '';
  messenger: Messenger;
  setModel(model: string, reasoningEffort?: ReasoningEffort | ''): Promise<void>;
  processMessage(message: { id: string; channelId: string; author: string; content: string }, attachments: string[], files?: string[]): Promise<void>;
  getRemainingTurnTimeMs(): number | null;
  dispose(): Promise<void>;
  deleteSession(): Promise<void>;
}

export abstract class Bot {
  protected readonly workspaceDir: string;
  protected readonly temporaryDir: string;
  protected readonly functionsDir: string;
  protected readonly agentName: string;
  protected readonly providerType: AgentProviderType;
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
    this.agentName = process.env.AGENT_NAME || 'agent';
    this.providerType = this.normalizeProvider(process.env.AI_PROVIDER || process.env.AGENT_PROVIDER);
    this.model = this.resolveInitialModel(this.providerType);
    this.sessionScope = (process.env.SESSION_SCOPE as SessionScope) || 'channel';
    this.counter = new RequestCounter(this.temporaryDir);
    this.scheduler = new Scheduler(
      path.join(this.workspaceDir, 'schedules.json'),
      (entry) => this.onScheduleFire(entry),
    );
    fs.mkdirSync(this.workspaceDir, { recursive: true });
    fs.mkdirSync(this.temporaryDir, { recursive: true });
    logger.log(`[BOT] Agent name: ${this.agentName}`);
    logger.log(`[BOT] Provider: ${this.providerType}`);
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
    const scopeId = this.sessionScope === 'server' && guildId ? guildId : channelId;
    return `${this.agentName}_${scopeId}`;
  }

  protected getOrCreateAgent(channelId: string, guildId?: string): Agent {
    const sessionKey = this.resolveSessionKey(channelId, guildId);
    let agent = this.sessions.get(sessionKey);
    if (!agent) {
      logger.log(`[BOT] Creating ${this.providerType} agent (model: ${this.model || 'default'}, scope: ${this.sessionScope}) for ${this.sessionScope === 'server' ? 'server' : 'channel'} ${sessionKey}`);
      const messenger = this.createMessenger(channelId);
      agent = this.createAgent(messenger, sessionKey);
      this.sessions.set(sessionKey, agent);
    } else if (agent.messenger.channelId !== channelId) {
      // Update active channel for typing indicators and status
      agent.messenger.setActiveChannel(channelId);
    }
    return agent;
  }

  protected async clearAgent(channelId: string, guildId?: string): Promise<Agent | undefined> {
    const sessionKey = this.resolveSessionKey(channelId, guildId);
    const agent = this.sessions.get(sessionKey);
    if (agent) {
      await agent.dispose();
      await agent.deleteSession();
      this.sessions.delete(sessionKey);
    }
    return agent;
  }

  abstract start(): Promise<void>;

  private normalizeProvider(value?: string): AgentProviderType {
    const normalizedValue = value?.trim().toLowerCase();
    if (!normalizedValue) return DEFAULT_PROVIDER;

    if (normalizedValue === 'copilot' || normalizedValue === 'claude') {
      return normalizedValue;
    }

    logger.log(`[BOT] Unknown provider "${value}" from AI_PROVIDER/AGENT_PROVIDER, falling back to ${DEFAULT_PROVIDER}`);
    return DEFAULT_PROVIDER;
  }

  private resolveInitialModel(provider: AgentProviderType): string {
    const envName = PROVIDER_MODEL_ENV[provider];
    return process.env[envName]?.trim() || '';
  }

  private createAgent(messenger: Messenger, sessionKey: string): Agent {
    switch (this.providerType) {
      case 'copilot':
        return new CopilotAgent(
          messenger,
          this.workspaceDir,
          this.functionsDir,
          this.model,
          this.clientManager,
          this.counter,
          this.scheduler,
          sessionKey,
          this.getBotId(),
        );
      case 'claude':
        return new ClaudeAgent(
          messenger,
          this.workspaceDir,
          this.model,
          this.counter,
          this.scheduler,
          sessionKey,
          this.getBotId(),
        );
    }
  }

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
    try {
      await agent.processMessage(incoming, [], []);
    } catch (err) {
      logger.error(`[BOT] Schedule processing failed for "${entry.id}":`, err);
    }
  }

  async shutdown(): Promise<void> {
    logger.log('[BOT] Shutting down...');
    this.scheduler.dispose();
    await Promise.all(
      [...this.sessions.values()].map(agent => agent.dispose())
    );
    this.sessions.clear();
    this.counter.flush();
    await this.clientManager.shutdown();
    logger.log('[BOT] Disconnected');
  }
}
