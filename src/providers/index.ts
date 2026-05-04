import { BaseProvider } from './provider.js';
import type { ProviderContext } from './provider.js';
import { ClaudeCodeProvider } from './claude.js';
import { CopilotCodeProvider } from './copilot.js';
import { CodexCodeProvider } from './codex.js';

export { BaseProvider } from './provider.js';
export type { ProviderContext, ProviderOptions } from './provider.js';
export { CopilotAgent } from './copilot_agent.js';
export { CopilotCodeProvider } from './copilot.js';
export { ClaudeCodeProvider } from './claude.js';
export { ClaudeAgent } from './claude_agent.js';
export { CodexCodeProvider } from './codex.js';
export { CodexAgent } from './codex_agent.js';

export function createClaudeProvider(context: ProviderContext): BaseProvider {
  return new ClaudeCodeProvider(context);
}

export function createCopilotProvider(context: ConstructorParameters<typeof CopilotCodeProvider>[0]): BaseProvider {
  return new CopilotCodeProvider(context);
}

export function createCodexProvider(context: ProviderContext): BaseProvider {
  return new CodexCodeProvider(context);
}