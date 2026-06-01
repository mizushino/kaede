import { BaseProvider } from './provider.js';
import type { ProviderContext } from './provider.js';
import { ClaudeCodeProvider } from './claude.js';
import { CopilotCodeProvider } from './copilot.js';
import { CodexCodeProvider } from './codex.js';
import { GeminiCodeProvider } from './gemini.js';
import { GenericAcpProvider } from './acp_generic.js';
import { OpenAICompatibleProvider } from './openai_compatible.js';

export { BaseProvider } from './provider.js';
export type { ProviderContext, ProviderOptions } from './provider.js';
export { CopilotAgent } from './copilot_agent.js';
export { CopilotCodeProvider } from './copilot.js';
export { ClaudeCodeProvider } from './claude.js';
export { ClaudeAgent } from './claude_agent.js';
export { CodexCodeProvider } from './codex.js';
export { CodexAgent } from './codex_agent.js';
export { GeminiCodeProvider } from './gemini.js';
export { GeminiAgent } from './gemini_agent.js';
export { AcpProvider } from './acp.js';
export { killAllAcpChildren } from './acp.js';
export { AcpAgent } from './acp_agent.js';
export { GenericAcpProvider } from './acp_generic.js';
export { GenericAcpAgent } from './acp_generic_agent.js';
export { OpenAICompatibleProvider } from './openai_compatible.js';
export { OpenAICompatibleAgent } from './openai_compatible_agent.js';

export function createClaudeProvider(context: ProviderContext): BaseProvider {
  return new ClaudeCodeProvider(context);
}

export function createCopilotProvider(context: ConstructorParameters<typeof CopilotCodeProvider>[0]): BaseProvider {
  return new CopilotCodeProvider(context);
}

export function createCodexProvider(context: ProviderContext): BaseProvider {
  return new CodexCodeProvider(context);
}

export function createGeminiProvider(context: ProviderContext): BaseProvider {
  return new GeminiCodeProvider(context);
}

export function createAcpProvider(context: ProviderContext): BaseProvider {
  return new GenericAcpProvider(context);
}

export function createOpenAIProvider(context: ConstructorParameters<typeof OpenAICompatibleProvider>[0]): BaseProvider {
  return new OpenAICompatibleProvider(context);
}
