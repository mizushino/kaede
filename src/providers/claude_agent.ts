import type { Messenger } from '../core/messenger.js';
import type { RequestCounter } from '../core/counter.js';
import type { Scheduler } from '../core/scheduler.js';
import { ClaudeCodeProvider } from './claude.js';
import { McpAgent, type McpAgentConfig } from './mcp_agent.js';

export type { ReasoningEffort } from './mcp_agent.js';

const CLAUDE_CONFIG: McpAgentConfig = {
  providerName: 'claude',
  fatalAuthErrorMatch: 'authentication failed',
  createProvider: (args) => new ClaudeCodeProvider(args),
  extraPromptLines: [
    'Do not use the built-in AskUserQuestion tool. In this bot environment, interactive questions must go through the Discord ask_user MCP tool.',
  ],
};

export class ClaudeAgent extends McpAgent {
  constructor(
    messenger: Messenger,
    workspaceDir: string,
    model: string,
    counter: RequestCounter,
    scheduler: Scheduler,
    sessionKey?: string,
    botUserId?: string,
  ) {
    super(CLAUDE_CONFIG, messenger, workspaceDir, model, counter, scheduler, sessionKey, botUserId);
  }
}
