import type { Messenger } from '../core/messenger.js';
import type { RequestCounter } from '../core/counter.js';
import type { Scheduler } from '../core/scheduler.js';
import { GeminiCodeProvider } from './gemini.js';
import type { ModelListing } from './base_agent.js';
import { McpAgent, type McpAgentConfig } from './mcp_agent.js';

export type { ReasoningEffort } from './mcp_agent.js';

const GEMINI_CONFIG: McpAgentConfig = {
  providerName: 'gemini',
  fatalAuthErrorMatch: 'authentication',
  createProvider: (args) => new GeminiCodeProvider(args),
  extraPromptLines: [
    'Do not rely on Gemini CLI authentication or browser prompts during a Discord turn. If authentication is missing, explain the issue instead of waiting for interactive login.',
    'For user clarification, use the Discord ask_user MCP tool instead of Gemini-specific elicitation flows.',
  ],
};

export class GeminiAgent extends McpAgent {
  constructor(
    messenger: Messenger,
    workspaceDir: string,
    model: string,
    counter: RequestCounter,
    scheduler: Scheduler,
    sessionKey?: string,
    botUserId?: string,
  ) {
    super(GEMINI_CONFIG, messenger, workspaceDir, model, counter, scheduler, sessionKey, botUserId);
  }

  static async listModels(): Promise<ModelListing> {
    const models = await GeminiCodeProvider.listModels({ workspaceDir: process.env.WORKSPACE_DIR });
    return {
      models: models.map(model => ({
        id: model.id,
        displayName: model.displayName,
        detail: model.description || '-',
        autocompleteLabel: model.description ? `${model.id} — ${model.description}` : model.id,
      })),
      columns: [
        { key: 'id', header: 'MODEL' },
        { key: 'detail', header: 'DETAIL' },
      ],
      footnote: '',
    };
  }
}
