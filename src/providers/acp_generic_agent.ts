import type { Messenger } from '../core/messenger.js';
import type { RequestCounter } from '../core/counter.js';
import type { Scheduler } from '../core/scheduler.js';
import { GenericAcpProvider } from './acp_generic.js';
import type { ModelListing } from './base_agent.js';
import { AcpAgent, type AcpAgentConfig } from './acp_agent.js';

export type { ReasoningEffort } from './mcp_agent.js';

const ACP_CONFIG: AcpAgentConfig = {
  providerName: process.env.ACP_NAME?.trim() || 'acp',
  fatalAuthErrorMatch: process.env.ACP_AUTH_ERROR_MATCH?.trim() || 'authentication',
  createProvider: (args) => new GenericAcpProvider(args),
  extraPromptLines: [
    'Do not rely on interactive CLI authentication or browser prompts during a Discord turn. If authentication is missing, explain the issue instead of waiting for interactive login.',
    'For user clarification, use the Discord ask_user MCP tool instead of provider-specific elicitation flows.',
  ],
};

export class GenericAcpAgent extends AcpAgent {
  constructor(
    messenger: Messenger,
    workspaceDir: string,
    model: string,
    counter: RequestCounter,
    scheduler: Scheduler,
    sessionKey?: string,
    botUserId?: string,
  ) {
    super(ACP_CONFIG, messenger, workspaceDir, model, counter, scheduler, sessionKey, botUserId);
  }

  static async listModels(): Promise<ModelListing> {
    const models = await GenericAcpProvider.listModels({ workspaceDir: process.env.WORKSPACE_DIR });
    return AcpAgent.buildModelListing(models);
  }
}
