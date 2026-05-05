import type { Messenger } from '../core/messenger.js';
import type { RequestCounter } from '../core/counter.js';
import type { Scheduler } from '../core/scheduler.js';
import type { ModelListing } from './base_agent.js';
import { McpAgent, type McpAgentConfig } from './mcp_agent.js';

export type AcpAgentConfig = McpAgentConfig;

export interface AcpModelInfo {
  id: string;
  displayName: string;
  description: string;
}

/**
 * Base class for agents backed by ACP (Agent Client Protocol) providers.
 * Currently a thin extension of {@link McpAgent} – it exists so that
 * ACP-specific provider helpers (model listing shape, etc.) live in one
 * place and future ACP-based agents can subclass it instead of duplicating
 * boilerplate.
 */
export abstract class AcpAgent extends McpAgent {
  constructor(
    config: AcpAgentConfig,
    messenger: Messenger,
    workspaceDir: string,
    model: string,
    counter: RequestCounter,
    scheduler: Scheduler,
    sessionKey?: string,
    botUserId?: string,
  ) {
    super(config, messenger, workspaceDir, model, counter, scheduler, sessionKey, botUserId);
  }

  /**
   * Convenience helper for `static listModels()` implementations: turns the
   * raw ACP model list (returned by `AcpProvider.listModels`) into a
   * `ModelListing` suitable for the slash-command UI.
   */
  static buildModelListing(
    models: AcpModelInfo[],
    options: { footnote?: string } = {},
  ): ModelListing {
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
      footnote: options.footnote ?? '',
    };
  }
}
