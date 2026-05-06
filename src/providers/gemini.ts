import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import * as acp from '@agentclientprotocol/sdk';
import { AcpProvider, listAcpModels } from './acp.js';

const SESSION_STATE_DIRNAME = 'gemini-sessions';
const DEFAULT_APPROVAL_MODE = 'default';
const DEFAULT_GEMINI_CONTEXT_WINDOW = 1_048_576;
const GEMINI_CONTEXT_WINDOW: Record<string, number> = {};

function parseExtraArgs(raw: string | undefined): string[] {
  return (raw || '')
    .split(' ')
    .map(token => token.trim())
    .filter(Boolean);
}

function buildGeminiArgs(): string[] {
  const configured = parseExtraArgs(process.env.GEMINI_ARGS);
  return configured.includes('--acp') ? configured : [...configured, '--acp'];
}

function resolveGeminiCommand(): string {
  if (process.env.GEMINI_COMMAND?.trim()) return process.env.GEMINI_COMMAND.trim();
  const localBin = path.resolve(process.cwd(), 'node_modules', '.bin', 'gemini');
  if (existsSync(localBin)) return localBin;
  return 'gemini';
}

function getGeminiContextWindow(modelId: string): number {
  return GEMINI_CONTEXT_WINDOW[modelId] ?? DEFAULT_GEMINI_CONTEXT_WINDOW;
}

export class GeminiCodeProvider extends AcpProvider {
  readonly name = 'gemini';

  static async listModels(
    options: { workspaceDir?: string } = {},
  ): Promise<Array<{ id: string; displayName: string; description: string }>> {
    const workspaceDir = path.resolve(options.workspaceDir || process.cwd());
    return listAcpModels({
      command: resolveGeminiCommand(),
      args: buildGeminiArgs(),
      env: { ...process.env as Record<string, string>, GEMINI_CLI_TRUST_WORKSPACE: process.env.GEMINI_CLI_TRUST_WORKSPACE ?? 'true' },
      cwd: workspaceDir,
      logTag: 'gemini',
    });
  }

  protected getIcon(): string {
    return '🔷';
  }

  protected getDisplayName(): string {
    return 'Gemini CLI';
  }

  override getRuntimeLabel(): string {
    return 'Gemini CLI (ACP)';
  }

  protected resolveCommand(): string {
    return resolveGeminiCommand();
  }

  protected buildArgs(): string[] {
    return buildGeminiArgs();
  }

  protected getStateSubdir(): string {
    return SESSION_STATE_DIRNAME;
  }

  protected override getApprovalMode(): string {
    return (process.env.GEMINI_APPROVAL_MODE || DEFAULT_APPROVAL_MODE).trim();
  }

  protected getContextWindow(modelId: string): number {
    return getGeminiContextWindow(modelId);
  }

  protected override getProviderEnv(): Record<string, string> {
    return {
      GEMINI_CLI_TRUST_WORKSPACE: process.env.GEMINI_CLI_TRUST_WORKSPACE ?? 'true',
    };
  }

  protected override getPermissionPromptHeading(): string {
    return 'Gemini がこの操作の許可を求めています。';
  }

  protected override extractUsageFromResponse(response: acp.PromptResponse): { used: number; modelId: string } | null {
    const meta = (response as { _meta?: Record<string, unknown> })._meta;
    const quota = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).quota : undefined;
    const tokenCount = quota && typeof quota === 'object'
      ? (quota as Record<string, unknown>).token_count as Record<string, unknown> | undefined
      : undefined;
    const inputTokens = tokenCount && typeof tokenCount.input_tokens === 'number'
      ? tokenCount.input_tokens
      : undefined;

    const used = response.usage?.totalTokens ?? inputTokens;
    if (typeof used !== 'number') return null;

    let modelId = this.currentModelId;
    if (!modelId) {
      const modelUsage = quota && typeof quota === 'object'
        ? (quota as Record<string, unknown>).model_usage
        : undefined;
      if (Array.isArray(modelUsage) && modelUsage[0] && typeof (modelUsage[0] as Record<string, unknown>).model === 'string') {
        modelId = (modelUsage[0] as { model: string }).model;
      }
    }

    return { used, modelId };
  }

  override async deleteSession(): Promise<void> {
    const sessionId = this.sessionId;
    await super.deleteSession();
    if (sessionId) {
      await this.cleanupCliHistory(sessionId);
    }
  }

  private async cleanupCliHistory(sessionId: string): Promise<void> {
    try {
      const home = process.env.HOME || process.env.USERPROFILE;
      if (!home) return;

      const chatsDir = path.join(home, '.gemini', 'tmp', 'workspace', 'chats');
      if (!existsSync(chatsDir)) return;

      const files = await fs.readdir(chatsDir);
      const sessionFiles = files.filter(f => f.includes(sessionId) && f.endsWith('.jsonl'));

      for (const file of sessionFiles) {
        const fullPath = path.join(chatsDir, file);
        await fs.unlink(fullPath);
        logger.log('[gemini] Cleaned up CLI history file: ' + file);
      }
    } catch (err) {
      logger.log('[gemini] Best-effort CLI history cleanup failed: ' + (err instanceof Error ? err.message : String(err)));
    }
  }
}
