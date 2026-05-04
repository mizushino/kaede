import type { Messenger } from '../core/messenger.js';
import type { RequestCounter } from '../core/counter.js';
import type { Scheduler } from '../core/scheduler.js';
import { CodexCodeProvider } from './codex.js';
import { McpAgent, type McpAgentConfig } from './mcp_agent.js';

export type { ReasoningEffort } from './mcp_agent.js';

const CODEX_CONFIG: McpAgentConfig = {
  providerName: 'codex',
  fatalAuthErrorMatch: 'authentication',
  createProvider: (args) => new CodexCodeProvider(args),
};

export class CodexAgent extends McpAgent {
  constructor(
    messenger: Messenger,
    workspaceDir: string,
    model: string,
    counter: RequestCounter,
    scheduler: Scheduler,
    sessionKey?: string,
    botUserId?: string,
  ) {
    super(CODEX_CONFIG, messenger, workspaceDir, model, counter, scheduler, sessionKey, botUserId);
  }
}
