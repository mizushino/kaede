import type { ContextUsageInfo, ReasoningEffort } from '../providers/provider.js';
import { RequestCounter } from './counter.js';
import { Scheduler } from './scheduler.js';
import type { Messenger } from './messenger.js';
import fs from 'fs';
import path from 'path';
import { writeFile } from 'fs/promises';
import { logger } from './logger.js';
import { getConfiguredTemporaryDir } from './temporary_dir.js';

export type SessionScope = 'channel' | 'server';
export const AGENT_PROVIDER_TYPES = ['copilot', 'claude', 'codex', 'gemini', 'acp'] as const;
export type AgentProviderType = typeof AGENT_PROVIDER_TYPES[number];

const DEFAULT_PROVIDER: AgentProviderType = 'copilot';
const PROVIDER_SDK_PACKAGE: Record<AgentProviderType, string> = {
  copilot: '@github/copilot-sdk',
  claude: '@anthropic-ai/claude-agent-sdk @anthropic-ai/claude-code',
  codex: '@openai/codex-sdk',
  gemini: '@agentclientprotocol/sdk @google/gemini-cli',
  acp: '@agentclientprotocol/sdk',
};

export interface Agent {
  model: string;
  reasoningEffort?: ReasoningEffort | '';
  messenger: Messenger;
  setModel(model: string, reasoningEffort?: ReasoningEffort | ''): Promise<void>;
  processMessage(message: { id: string; channelId: string; author: string; content: string }, attachments: string[], files?: string[]): Promise<void>;
  getRemainingTurnTimeMs(): number | null;
  getContextUsage(): Promise<ContextUsageInfo | null>;
  dispose(): Promise<void>;
  deleteSession(): Promise<void>;
}

export abstract class Bot {
  protected readonly workspaceDir: string;
  protected readonly temporaryDir: string;
  protected readonly configDir: string;
  protected readonly functionsDir: string;
  protected readonly agentName: string;
  protected readonly providerType: AgentProviderType;
  protected readonly model: string;
  protected readonly sessionScope: SessionScope;
  protected readonly counter: RequestCounter;
  protected readonly scheduler: Scheduler;
  protected sessions = new Map<string, Agent>();
  private processedMessages = new Set<string>();

  constructor() {
    this.workspaceDir = process.env.WORKSPACE_DIR || 'workspace';
    this.temporaryDir = getConfiguredTemporaryDir();
    this.functionsDir = process.env.FUNCTIONS_DIR || path.join(this.workspaceDir, 'functions');
    this.agentName = process.env.AGENT_NAME || 'agent';
    this.configDir = path.resolve(process.env.CONFIG_DIR || path.join('.kaede', this.agentName));
    this.providerType = this.normalizeProvider(process.env.AGENT_PROVIDER);
    this.model = this.resolveInitialModel(this.providerType);
    this.sessionScope = (process.env.SESSION_SCOPE as SessionScope) || 'channel';
    this.counter = new RequestCounter(this.configDir);
    this.scheduler = new Scheduler(
      path.join(this.configDir, 'schedules.json'),
      (entry) => this.onScheduleFire(entry),
    );
    fs.mkdirSync(this.workspaceDir, { recursive: true });
    fs.mkdirSync(this.temporaryDir, { recursive: true });
    fs.mkdirSync(this.configDir, { recursive: true });
    
    // Setup IPC watcher for remote clear commands
    const ipcDir = path.join(this.configDir, 'ipc');
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.watch(ipcDir, (eventType, filename) => {
      if (filename && filename.startsWith('clear_')) {
        const sessionKey = filename.replace('clear_', '');
        logger.log(`[BOT] Received IPC clear signal for session: ${sessionKey}`);
        const agent = this.sessions.get(sessionKey);
        if (agent) {
          agent.dispose().then(() => agent.deleteSession()).catch(err => logger.error('[BOT] IPC clear error:', err));
          this.sessions.delete(sessionKey);
        } else {
          // If agent is not in memory, we still need to clear persistent state.
          this.loadAgentClass()
            .then(() => {
              // Hacky way to call deleteSession when channel is unknown (just use sessionKey as channel)
              const [channelId] = sessionKey.split(':');
              const messenger = this.createMessenger(channelId);
              const tempAgent = this.createAgent(messenger, sessionKey);
              return tempAgent.deleteSession().then(() => tempAgent.dispose());
            })
            .catch(err => logger.error('[BOT] IPC persistent clear error:', err));
        }
        fs.unlink(path.join(ipcDir, filename), () => {});
      }
    });

    logger.log(`[BOT] Agent name: ${this.agentName}`);
    logger.log(`[BOT] Provider: ${this.providerType}`);
    logger.log(`[BOT] Config dir: ${this.configDir}`);
    logger.log(`[BOT] Session scope: ${this.sessionScope}`);
  }

  protected abstract createMessenger(channelId: string): Messenger;
  protected abstract getBotId(): string;

  /**
   * Lazily-loaded agent constructor for the active provider. Populated by
   * `loadAgentClass()` on first need so that SDKs for unselected providers
   * are never imported.
   */
  protected agentClass: any = null;

  /**
   * Loads the agent class for the active provider via dynamic import. The
   * provider's SDK is listed in `optionalDependencies`, so this is the point
   * where a missing SDK surfaces a clear error.
   */
  protected async loadAgentClass(): Promise<void> {
    if (this.agentClass) return;
    const sdkName = PROVIDER_SDK_PACKAGE[this.providerType];
    try {
      switch (this.providerType) {
        case 'copilot': {
          const mod = await import('../providers/copilot_agent.js');
          this.agentClass = mod.CopilotAgent;
          return;
        }
        case 'claude': {
          const mod = await import('../providers/claude_agent.js');
          this.agentClass = mod.ClaudeAgent;
          return;
        }
        case 'codex': {
          const mod = await import('../providers/codex_agent.js');
          this.agentClass = mod.CodexAgent;
          return;
        }
        case 'gemini': {
          const mod = await import('../providers/gemini_agent.js');
          this.agentClass = mod.GeminiAgent;
          return;
        }
        case 'acp': {
          const mod = await import('../providers/acp_generic_agent.js');
          this.agentClass = mod.GenericAcpAgent;
          return;
        }
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      const message = (err as Error).message ?? '';
      if (
        code === 'ERR_MODULE_NOT_FOUND' ||
        code === 'MODULE_NOT_FOUND' ||
        message.includes(sdkName)
      ) {
        throw new Error(
          `Optional dependency "${sdkName}" is required for provider "${this.providerType}" but is not installed. ` +
          `Install it with: npm install ${sdkName}`,
        );
      }
      throw err;
    }
  }

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

  /**
   * Pre-initialize the active provider's resources (e.g. shared SDK client)
   * to reduce first-message latency. Safe to call multiple times.
   */
  async warmupProvider(): Promise<void> {
    await this.loadAgentClass();
    if (this.agentClass && typeof this.agentClass.warmup === 'function') {
      await this.agentClass.warmup();
    }
  }

  protected async getOrCreateAgent(channelId: string, guildId?: string): Promise<Agent> {
    const sessionKey = this.resolveSessionKey(channelId, guildId);
    let agent = this.sessions.get(sessionKey);
    if (!agent) {
      logger.log(`[BOT] Creating ${this.providerType} agent (model: ${this.model || 'default'}, scope: ${this.sessionScope}) for ${this.sessionScope === 'server' ? 'server' : 'channel'} ${sessionKey}`);
      await this.loadAgentClass();
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
    let agent = this.sessions.get(sessionKey);
    if (agent) {
      await agent.dispose();
      await agent.deleteSession();
      this.sessions.delete(sessionKey);
    } else {
      // If agent is not in memory, we still need to clear its persistent state.
      // We lazily load the agent class and create a temporary instance to call deleteSession.
      await this.loadAgentClass();
      const messenger = this.createMessenger(channelId);
      agent = this.createAgent(messenger, sessionKey);
      await agent.deleteSession();
      await agent.dispose();
    }
    return agent;
  }

  abstract start(): Promise<void>;

  private normalizeProvider(value?: string): AgentProviderType {
    const normalizedValue = value?.trim().toLowerCase();
    if (!normalizedValue) return DEFAULT_PROVIDER;

    if ((AGENT_PROVIDER_TYPES as readonly string[]).includes(normalizedValue)) {
      return normalizedValue as AgentProviderType;
    }

    logger.log(`[BOT] Unknown provider "${value}" from AGENT_PROVIDER, falling back to ${DEFAULT_PROVIDER}`);
    return DEFAULT_PROVIDER;
  }

  private resolveInitialModel(_provider: AgentProviderType): string {
    return process.env.AGENT_MODEL?.trim() || '';
  }

  private createAgent(messenger: Messenger, sessionKey: string): Agent {
    const AgentCtor = this.agentClass;
    if (!AgentCtor) {
      throw new Error('Agent class not loaded; call loadAgentClass() first.');
    }
    return new AgentCtor(
      messenger,
      this.workspaceDir,
      this.model,
      this.counter,
      this.scheduler,
      sessionKey,
      this.getBotId(),
    );
  }

  /** Called by Scheduler when a cron job fires. */
  private async onScheduleFire(entry: import('./scheduler.js').ScheduleEntry): Promise<void> {
    logger.log(`[BOT] Schedule fired: "${entry.id}" → ch:${entry.channelId}`);
    const agent = await this.getOrCreateAgent(entry.channelId, entry.guildId);
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
    if (this.agentClass && typeof this.agentClass.shutdownProcess === 'function') {
      await this.agentClass.shutdownProcess();
    }
    logger.log('[BOT] Disconnected');
  }
}
