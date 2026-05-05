import { existsSync, readFileSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import {
  Codex,
  type ApprovalMode,
  type CodexOptions,
  type CommandExecutionItem,
  type FileChangeItem,
  type McpToolCallItem,
  type ModelReasoningEffort,
  type SandboxMode,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type WebSearchItem,
} from '@openai/codex-sdk';
import { BaseProvider } from './provider.js';
import type { ProviderContext, ProviderOptions, ReasoningEffort } from './provider.js';
import { logger } from '../core/logger.js';

const DEFAULT_TEMPORARY_DIR = path.resolve(process.env.TEMPORARY_DIR || 'tmp');
const THREAD_STATE_DIRNAME = 'codex-threads';

function parsePositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;

  const value = Number(raw);
  if (Number.isInteger(value) && value > 0) return value;

  logger.log(`[codex] Ignoring invalid ${name}=${raw}; expected a positive integer.`);
  return undefined;
}

function getThreadStateFilePath(sessionKey: string): string {
  const safe = encodeURIComponent(sessionKey);
  return path.join(DEFAULT_TEMPORARY_DIR, THREAD_STATE_DIRNAME, `${safe}.json`);
}

interface QueryState {
  sentDiscordMessage: boolean;
}

export class CodexCodeProvider extends BaseProvider {
  readonly name = 'codex';

  /**
   * Codex SDK does not expose a model-list API (the underlying `codex` CLI
   * has no `models` subcommand). We surface a small static fallback which
   * can be overridden via the `CODEX_MODELS` env var (comma-separated).
   */
  static listModels(): Array<{ id: string; displayName: string; effort: string }> {
    const raw = (process.env.CODEX_MODELS || '').trim();
    const ids = raw
      ? raw.split(',').map(value => value.trim()).filter(Boolean)
      : [
          'gpt-5.5',
          'gpt-5.4',
          'gpt-5.4-mini',
          'gpt-5.3-codex',
          'gpt-5.3-codex-spark',
          'gpt-5.2',
        ];
    return ids.map(id => ({
      id,
      displayName: id,
      effort: 'minimal/low/medium/high/xhigh',
    }));
  }

  private codex?: Codex;
  private threadId: string | null = null;
  private threadStateLoaded = false;
  private currentAbort?: AbortController;

  protected getIcon(): string {
    return '🟢';
  }

  protected getDisplayName(): string {
    return 'Codex SDK';
  }

  async setModel(): Promise<void> {
    // Each turn rebuilds thread options from latest model; nothing to invalidate.
  }

  sendToTerminal(text: string): void {
    if (text.includes('\u0003') || text.includes('\x03')) {
      this.currentAbort?.abort();
      return;
    }
    super.sendToTerminal(text);
  }

  dispose(): void {
    this.currentAbort?.abort();
    this.currentAbort = undefined;
    super.dispose();
  }

  async deleteSession(): Promise<void> {
    this.threadId = null;
    this.threadStateLoaded = true;
    try {
      await fs.unlink(getThreadStateFilePath(this.context.sessionKey));
    } catch {
      /* ignore */
    }
    this.dispose();
  }

  async sendPrompt(prompt: string, options?: ProviderOptions): Promise<void> {
    await this.ensureThreadStateLoaded();

    const codex = this.getCodex();
    const threadOptions = this.buildThreadOptions(options);
    const thread: Thread = this.threadId
      ? codex.resumeThread(this.threadId, threadOptions)
      : codex.startThread(threadOptions);

    const abort = new AbortController();
    this.currentAbort = abort;

    const state: QueryState = { sentDiscordMessage: false };
    let turnFailed: string | null = null;

    try {
      logger.log(`[${this.name}] Sending turn (thread=${this.threadId ?? 'new'}):\n${prompt.slice(0, 300)}`);
      const { events } = await thread.runStreamed(prompt, { signal: abort.signal });

      for await (const event of events) {
        const stop = this.handleEvent(event, state);
        if (stop) {
          turnFailed = stop;
          break;
        }
      }
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      this.currentAbort = undefined;
      this.context.messenger.clearStatus();
      this.context.messenger.stopTyping();
    }

    if (turnFailed) {
      throw new Error(turnFailed);
    }
  }

  private handleEvent(event: ThreadEvent, state: QueryState): string | null {
    switch (event.type) {
      case 'thread.started':
        this.threadId = event.thread_id;
        void this.persistThreadState();
        return null;

      case 'turn.started':
        return null;

      case 'turn.completed':
        logger.log(`[${this.name}] Turn completed: in=${event.usage.input_tokens} out=${event.usage.output_tokens} reasoning=${event.usage.reasoning_output_tokens}`);
        return null;

      case 'turn.failed':
        return event.error.message || 'codex turn failed';

      case 'error':
        return event.message || 'codex stream error';

      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        this.handleItem(event.item, event.type, state);
        return null;
    }

    return null;
  }

  private handleItem(item: ThreadItem, phase: 'item.started' | 'item.updated' | 'item.completed', state: QueryState): void {
    switch (item.type) {
      case 'command_execution': {
        const cmd = item as CommandExecutionItem;
        this.context.messenger.setStatus(this.formatToolStatus('bash', cmd.command));
        if (phase === 'item.completed' && typeof cmd.exit_code === 'number' && cmd.exit_code !== 0) {
          logger.log(`[${this.name}] command failed (exit ${cmd.exit_code}): ${cmd.command.slice(0, 120)}`);
        }
        return;
      }

      case 'file_change': {
        const fc = item as FileChangeItem;
        const detail = fc.changes.map(c => `${c.kind}:${c.path}`).slice(0, 2).join(', ');
        this.context.messenger.setStatus(this.formatToolStatus('edit', detail));
        return;
      }

      case 'mcp_tool_call': {
        const call = item as McpToolCallItem;
        const normalized = this.normalizeToolName(call.tool);
        const detail = this.formatToolDetail(normalized, this.coerceArgs(call.arguments));

        if (phase === 'item.started') {
          logger.log(`[${this.name}] mcp tool: ${call.server}/${call.tool}${detail ? ` | ${detail}` : ''}`);
        }

        if (normalized === 'send_message') {
          state.sentDiscordMessage = true;
          this.context.messenger.stopTyping();
        }

        this.context.messenger.setStatus(this.formatToolStatus(normalized, detail || undefined));
        return;
      }

      case 'web_search': {
        const ws = item as WebSearchItem;
        this.context.messenger.setStatus(this.formatToolStatus('web_fetch', ws.query));
        return;
      }

      case 'reasoning':
        this.context.messenger.setStatus(this.formatToolStatus('report_intent'));
        return;

      case 'todo_list':
        this.context.messenger.setStatus(this.formatToolStatus('report_intent'));
        return;

      case 'agent_message':
        // Codex may print final agent text outside MCP; we rely on send_message MCP for Discord output.
        if (phase === 'item.completed') {
          logger.log(`[${this.name}] agent_message: ${(item.text || '').slice(0, 120)}`);
        }
        return;

      case 'error':
        logger.log(`[${this.name}] item error: ${item.message}`);
        return;
    }
  }

  private coerceArgs(args: unknown): Record<string, unknown> {
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      return args as Record<string, unknown>;
    }
    return {};
  }

  private getCodex(): Codex {
    if (!this.codex) {
      this.codex = new Codex({
        ...(process.env.CODEX_PATH ? { codexPathOverride: process.env.CODEX_PATH } : {}),
        ...(process.env.CODEX_BASE_URL ? { baseUrl: process.env.CODEX_BASE_URL } : {}),
        ...(process.env.CODEX_API_KEY ? { apiKey: process.env.CODEX_API_KEY } : {}),
        config: this.buildCodexConfig(),
      });
    }
    return this.codex;
  }

  private buildCodexConfig(): NonNullable<CodexOptions['config']> {
    const agent = process.env.AGENT || process.env.AGENT_NAME || '';
    const repoRoot = path.resolve(process.cwd());
    const mcpEnv: Record<string, string> = {
      KAEDE_SESSION_KEY: this.context.sessionKey,
      TEMPORARY_DIR: process.env.TEMPORARY_DIR || 'tmp',
    };
    if (agent) mcpEnv.AGENT = agent;
    if (process.env.PATH) mcpEnv.PATH = process.env.PATH;
    if (process.env.HOME) mcpEnv.HOME = process.env.HOME;

    const config: NonNullable<CodexOptions['config']> = {
      mcp_servers: {
        discord: {
          command: 'npm',
          args: ['run', '--silent', '--prefix', repoRoot, 'mcp'],
          env: mcpEnv,
          default_tools_approval_mode: 'approve',
        },
      },
    };

    if (process.env.CODEX_CONFIG_JSON) {
      try {
        const extra = JSON.parse(process.env.CODEX_CONFIG_JSON);
        if (extra && typeof extra === 'object') Object.assign(config, extra);
      } catch (err) {
        logger.error(`[${this.name}] Failed to parse CODEX_CONFIG_JSON:`, err);
      }
    }

    this.applyCodexContextConfig(config);

    return config;
  }

  private applyCodexContextConfig(config: NonNullable<CodexOptions['config']>): void {
    const autoCompactTokenLimit = parsePositiveIntegerEnv('CODEX_AUTO_COMPACT_TOKEN_LIMIT');

    if (autoCompactTokenLimit) {
      config.model_auto_compact_token_limit = autoCompactTokenLimit;
    }
  }

  private buildThreadOptions(options: ProviderOptions | undefined): ThreadOptions {
    const workspaceDir = path.resolve(this.context.workspaceDir);
    const additionalDirectories = new Set<string>();
    additionalDirectories.add(workspaceDir);
    additionalDirectories.add(path.resolve(process.cwd()));

    const model = (options?.model || process.env.AGENT_MODEL || '').trim();
    const effort = this.resolveEffort(options);
    const sandboxMode = this.resolveSandboxMode();
    const approvalPolicy = this.resolveApprovalPolicy();

    return {
      ...(model ? { model } : {}),
      ...(effort ? { modelReasoningEffort: effort } : {}),
      sandboxMode,
      approvalPolicy,
      workingDirectory: workspaceDir,
      skipGitRepoCheck: true,
      networkAccessEnabled: process.env.CODEX_NETWORK_DISABLED ? false : true,
      webSearchEnabled: process.env.CODEX_WEB_SEARCH_DISABLED ? false : true,
      additionalDirectories: [...additionalDirectories],
    };
  }

  private resolveEffort(options: ProviderOptions | undefined): ModelReasoningEffort | undefined {
    const raw = (options?.reasoningEffort || process.env.AGENT_REASONING_EFFORT || '').trim().toLowerCase();
    if (raw === 'minimal' || raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh') return raw;
    return undefined;
  }

  private resolveSandboxMode(): SandboxMode {
    const raw = (process.env.CODEX_SANDBOX_MODE || 'workspace-write').trim();
    if (raw === 'read-only' || raw === 'workspace-write' || raw === 'danger-full-access') return raw;
    return 'workspace-write';
  }

  private resolveApprovalPolicy(): ApprovalMode {
    const raw = (process.env.CODEX_APPROVAL_POLICY || 'never').trim();
    if (raw === 'on-request' || raw === 'untrusted') {
      logger.log(`[${this.name}] CODEX_APPROVAL_POLICY=${raw} cannot use Discord approval (Codex SDK has no external approval callback); forcing 'never'.`);
      return 'never';
    }
    if (raw === 'never' || raw === 'on-failure') return raw;
    return 'never';
  }

  private async ensureThreadStateLoaded(): Promise<void> {
    if (this.threadStateLoaded) return;
    this.threadStateLoaded = true;

    const filePath = getThreadStateFilePath(this.context.sessionKey);
    if (!existsSync(filePath)) return;
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.threadId === 'string') {
        this.threadId = parsed.threadId;
        logger.log(`[${this.name}] Restored thread ${this.threadId}`);
      }
    } catch (err) {
      logger.error(`[${this.name}] Failed to load thread state:`, err);
    }
  }

  private async persistThreadState(): Promise<void> {
    if (!this.threadId) return;
    const filePath = getThreadStateFilePath(this.context.sessionKey);
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify({ threadId: this.threadId, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
    } catch (err) {
      logger.error(`[${this.name}] Failed to persist thread state:`, err);
    }
  }
}

// Re-export so callers can refer to Codex effort type by alias if useful.
export type { ReasoningEffort };
