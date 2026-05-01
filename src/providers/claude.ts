import { createHash, randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { deleteSession, getSessionInfo, query, type ModelInfo, type Options, type PermissionMode, type PermissionResult, type Query } from '@anthropic-ai/claude-agent-sdk';
import { BaseProvider } from './provider.js';
import type { ElicitationSchema, ProviderOptions } from './provider.js';
import { logger } from '../core/logger.js';
import { getClaudeDiscordAllowedTools } from '../core/tool_contract.js';

const require_ = createRequire(import.meta.url);

function isGlibcRuntime(): boolean {
  try {
    const report = (process as unknown as { report?: { getReport(): { header?: { glibcVersionRuntime?: string } } } }).report?.getReport();
    return Boolean(report?.header?.glibcVersionRuntime);
  } catch {
    return false;
  }
}

function resolveClaudeBinary(): string | undefined {
  if (process.env.CLAUDE_COMMAND) return process.env.CLAUDE_COMMAND;
  if (process.platform !== 'linux') return undefined;

  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const glibcPkg = `@anthropic-ai/claude-agent-sdk-linux-${arch}`;
  const muslPkg = `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl`;
  const order = isGlibcRuntime() ? [glibcPkg, muslPkg] : [muslPkg, glibcPkg];

  for (const pkg of order) {
    try {
      const pkgJson = require_.resolve(`${pkg}/package.json`);
      const candidate = path.join(path.dirname(pkgJson), 'claude');
      if (existsSync(candidate)) return candidate;
    } catch {
      /* try next */
    }
  }

  return undefined;
}

const CLI_SESSION_TIMEOUT = Number(process.env.SESSION_TIMEOUT_MS) || 10_800_000;
const USER_RESPONSE_TIMEOUT = Number(process.env.USER_RESPONSE_TIMEOUT_MS) || 300_000;

interface QueryState {
  sentDiscordMessage: boolean;
}

export class ClaudeCodeProvider extends BaseProvider {
  readonly name = 'claude';

  static async listModels(options: { workspaceDir?: string; claudeCommand?: string } = {}): Promise<ModelInfo[]> {
    const cwd = path.resolve(options.workspaceDir || process.cwd());
    const claudeCommand = options.claudeCommand || resolveClaudeBinary();
    const abortController = new AbortController();

    // Streaming-input mode (empty async iterable) lets us use control requests
    // like supportedModels() without sending an actual user prompt.
    const stream = query({
      prompt: (async function* () {
        // Wait until aborted so we can issue the control request and bail out.
        await new Promise<void>(resolve => {
          abortController.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      })(),
      options: {
        abortController,
        cwd,
        env: { ...process.env } as Record<string, string>,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        ...(claudeCommand ? { pathToClaudeCodeExecutable: claudeCommand } : {}),
      },
    });

    try {
      const models = await stream.supportedModels();
      return models;
    } finally {
      abortController.abort();
      stream.close();
    }
  }

  private activeQuery?: Query;
  private activeAbortController?: AbortController;
  private currentSessionId?: string;
  private timedOut = false;

  protected getIcon(): string {
    return '⚜️';
  }

  protected getDisplayName(): string {
    return 'Claude Agent SDK';
  }

  private setDetectedStatus(content?: string | null): void {
    if (!content) return;
    const status = this.detectStructuredStatus(content);
    if (status) {
      this.context.messenger.setStatus(status);
    }
  }

  private detectStructuredStatus(content: string): string | null {
    const tail = content.split('\n').slice(-40).join('\n');
    const normalizeDetail = (value: string): string => value.replace(/\s+/g, ' ').trim();
    const matchDetail = (pattern: RegExp): string | null => {
      const match = tail.match(pattern);
      return match?.[1] ? normalizeDetail(match[1]) : null;
    };

    if (this.isChoicePrompt(tail)) {
      return this.formatToolStatus('ask_user');
    }

    const bashCommand = matchDetail(/Bash\(([\s\S]{1,180}?)\)/);
    if (bashCommand) return this.formatToolStatus('bash', bashCommand);

    const viewTarget = matchDetail(/(?:Read|View)\(([\s\S]{1,180}?)\)/);
    if (viewTarget) return this.formatToolStatus('view', viewTarget);

    const editTarget = matchDetail(/(?:Edit|Write|MultiEdit)\(([\s\S]{1,180}?)\)/);
    if (editTarget) return this.formatToolStatus('edit', editTarget);

    const globTarget = matchDetail(/Glob\(([\s\S]{1,180}?)\)/);
    if (globTarget) return this.formatToolStatus('glob', globTarget);

    const grepTarget = matchDetail(/(?:Grep|Search)\(([\s\S]{1,180}?)\)/);
    if (grepTarget) return this.formatToolStatus('grep', grepTarget);

    const webTarget = matchDetail(/WebSearch\(([\s\S]{1,180}?)\)/);
    if (webTarget) return this.formatToolStatus('web_fetch', webTarget);

    if (tail.includes('mcp__discord__send_message') || tail.includes('/api/v10/channels/') && tail.includes('/messages')) {
      return this.formatToolStatus('send_message');
    }

    if (tail.includes('mcp__discord__get_messages')) {
      return this.formatToolStatus('get_messages');
    }

    if (tail.includes('mcp__discord__get_channels')) {
      return this.formatToolStatus('get_channels');
    }

    if (tail.includes('mcp__discord__get_servers')) {
      return this.formatToolStatus('get_servers');
    }

    if (tail.includes('mcp__discord__ask_user')) {
      return this.formatToolStatus('ask_user');
    }

    if (/reading\s+\d+\s+file/i.test(tail) || /listing\s+\d+\s+director/i.test(tail)) {
      return this.formatToolStatus('view');
    }

    if (tail.includes('replying') || tail.includes('返信を送信しました')) {
      return this.formatToolStatus('send_message');
    }

    if (tail.includes('cogitated') || tail.includes('thinking') || tail.includes('working')) {
      return this.formatToolStatus('report_intent');
    }

    return null;
  }

  private isChoicePrompt(content: string): boolean {
    const lower = content.toLowerCase();
    return lower.includes('do you want to proceed')
      || lower.includes('proceed?')
      || lower.includes('continue?')
      || lower.includes('allow once')
      || lower.includes('allow always')
      || lower.includes('approve')
      || lower.includes('confirm')
      || /(?:^|\n)\s*(?:❯\s*)?\d+\./.test(content)
      || /│\s*\d+\.\s+.+│/.test(content);
  }

  private getEnvironmentVariables(): Record<string, string | undefined> {
    return {
      ...process.env,
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      USER: process.env.USER ?? '',
      SHELL: process.env.SHELL ?? '/bin/bash',
      TERM: 'dumb',
      FORCE_COLOR: '0',
      CLICOLOR: '0',
      NO_COLOR: '1',
    };
  }

  sendToTerminal(text: string): void {
    if (text.includes('\u0003') || text.includes('\x03')) {
      void this.activeQuery?.interrupt().catch(err => {
        logger.error(`[${this.name}] Failed to interrupt query:`, err);
      });
      return;
    }

    logger.log(`[${this.name}] Ignoring terminal input because Claude SDK provider is not terminal-driven`);
  }

  dispose(): void {
    this.timedOut = false;
    this.activeAbortController?.abort();
    this.activeAbortController = undefined;
    this.activeQuery?.close();
    this.activeQuery = undefined;
    this.currentSessionId = undefined;
    super.dispose();
  }

  async deleteSession(): Promise<void> {
    const sessionId = this.currentSessionId ?? this.getStableSessionId();
    this.dispose();

    try {
      await deleteSession(sessionId, { dir: path.resolve(this.context.workspaceDir) });
      logger.log(`[${this.name}] Deleted session ${sessionId}`);
    } catch (err) {
      logger.log(`[${this.name}] Failed to delete session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async setModel(): Promise<void> {
    this.dispose();
  }

  async sendPrompt(prompt: string, options?: ProviderOptions): Promise<void> {
    this.timedOut = false;

    const abortController = new AbortController();
    this.activeAbortController = abortController;

    const timeout = setTimeout(() => {
      this.timedOut = true;
      abortController.abort();
      this.activeQuery?.close();
    }, CLI_SESSION_TIMEOUT);

    try {
      const requestedModel = options?.model?.trim() || undefined;

      try {
        await this.executeQuery(prompt, options, abortController, requestedModel, true);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!requestedModel || !this.isModelSelectionErrorMessage(message)) {
          throw err;
        }

        logger.log(`[${this.name}] Model ${requestedModel} was rejected by Claude at runtime; retrying with the default model`);
        await this.executeQuery(prompt, options, abortController, undefined, false);
      }
    } catch (err) {
      if (this.timedOut) {
        throw new Error(`${this.name} query timed out after ${CLI_SESSION_TIMEOUT}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
      this.activeQuery?.close();
      this.activeQuery = undefined;
      this.activeAbortController = undefined;
      this.context.messenger.clearStatus();
      this.context.messenger.stopTyping();
    }
  }

  private async executeQuery(
    prompt: string,
    options: ProviderOptions | undefined,
    abortController: AbortController,
    modelOverride: string | undefined,
    allowResume: boolean,
  ): Promise<void> {
    const state: QueryState = { sentDiscordMessage: false };

    const queryOptions = await this.buildQueryOptions(options, abortController, modelOverride, allowResume, state);
    const stream = query({ prompt, options: queryOptions });
    this.activeQuery = stream;
    try {

    let authError: string | null = null;
    let resultError: string | null = null;
    let sawResult = false;

    for await (const message of stream) {
      this.currentSessionId = message.session_id;

      if (message.type === 'auth_status') {
        this.context.messenger.setStatus(`${this.getIcon()} Claude 認証待機中...`);
        if (message.error) authError = message.error;
        continue;
      }

      if (message.type === 'assistant' && message.error) {
        authError = this.describeAssistantError(message.error);
        continue;
      }

      if (message.type === 'assistant') {
        this.handleAssistantToolUses(message, state);
        continue;
      }

      if (message.type === 'tool_use_summary') {
        this.setDetectedStatus(message.summary);
        continue;
      }

      if (message.type === 'tool_progress') {
        const normalized = this.normalizeToolName(message.tool_name);
        this.context.messenger.setStatus(this.formatToolStatus(normalized));
        continue;
      }

      if (message.type === 'system') {
        if (message.subtype === 'task_progress' && message.last_tool_name) {
          this.context.messenger.setStatus(this.formatToolStatus(this.normalizeToolName(message.last_tool_name)));
        } else if (message.subtype === 'task_updated') {
          this.setDetectedStatus(message.patch.description);
        } else if (message.subtype === 'notification' && message.priority !== 'low') {
          this.setDetectedStatus(message.text);
          logger.log(`[${this.name}] notification: ${message.text}`);
        } else if (message.subtype === 'init') {
          const failedServers = message.mcp_servers.filter(server => server.status === 'failed');
          if (failedServers.length > 0) {
            logger.log(`[${this.name}] MCP connection issues: ${failedServers.map(server => `${server.name}:${server.status}`).join(', ')}`);
          }
        }
        continue;
      }

      if (message.type === 'result') {
        sawResult = true;

        if (message.subtype !== 'success') {
          resultError = this.formatResultError(message.errors);
          continue;
        }

        if (!state.sentDiscordMessage && message.result.trim()) {
          logger.log(`[${this.name}] Result completed without discord send_message tool usage`);
        }
      }
    }

    if (authError) {
      throw new Error(authError);
    }

    if (resultError) {
      throw new Error(resultError);
    }

    if (!sawResult) {
      throw new Error('claude query ended without a result');
    }
    } finally {
      if (this.activeQuery === stream) {
        this.activeQuery?.close();
        this.activeQuery = undefined;
      }
    }
  }

  private async buildQueryOptions(
    options: ProviderOptions | undefined,
    abortController: AbortController,
    modelOverride: string | undefined,
    allowResume: boolean,
    state: QueryState,
  ): Promise<Options> {
    const workspaceDir = path.resolve(this.context.workspaceDir);
    const permissionMode = this.getPermissionMode();
    const env = this.getEnvironmentVariables();
    const sessionOptions = await this.resolveSessionOptions(workspaceDir, allowResume);
    const claudeCommand = resolveClaudeBinary();

    return {
      abortController,
      cwd: workspaceDir,
      env,
      model: modelOverride,
      ...(this.resolveEffort(options) ? { effort: this.resolveEffort(options) } : {}),
      permissionMode,
      ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      ...(claudeCommand ? { pathToClaudeCodeExecutable: claudeCommand } : {}),
      ...(process.env.CLAUDE_ARGS ? { extraArgs: this.parseExtraArgs(process.env.CLAUDE_ARGS) } : {}),
      tools: { type: 'preset', preset: 'claude_code' },
      allowedTools: this.getAllowedTools(),
      disallowedTools: this.getDisallowedTools(),
      additionalDirectories: this.getAdditionalDirectories(),
      mcpServers: this.getMcpServers(),
      canUseTool: async (toolName, input, toolOptions): Promise<PermissionResult> => {
        const normalizedToolName = this.normalizeToolName(toolName);
        const detail = this.formatToolDetail(normalizedToolName, input);

        if (normalizedToolName === 'send_message') {
          state.sentDiscordMessage = true;
          this.context.messenger.stopTyping();
        }

        this.context.messenger.setStatus(this.formatToolStatus(normalizedToolName, detail || undefined));

        if (permissionMode === 'bypassPermissions' || permissionMode === 'acceptEdits') {
          return {
            behavior: 'allow',
            toolUseID: toolOptions.toolUseID,
          };
        }

        const approved = await this.context.messenger.requestApproval(
          this.buildPermissionPrompt(toolName, input, toolOptions),
          USER_RESPONSE_TIMEOUT,
        );

        if (approved) {
          return {
            behavior: 'allow',
            toolUseID: toolOptions.toolUseID,
          };
        }

        return {
          behavior: 'deny',
          message: 'User denied the requested Claude tool action.',
          toolUseID: toolOptions.toolUseID,
        };
      },
      onElicitation: async (request) => {
        if (request.mode === 'url' && request.url) {
          const approved = await this.context.messenger.requestApproval(
            `${request.title || 'Claude が認証を要求しています。'}\n\n${request.message}\n${request.url}`,
            USER_RESPONSE_TIMEOUT,
          );

          return approved ? { action: 'accept' } : { action: 'decline' };
        }

        const schema = this.toJsonSchemaShape(request.requestedSchema);
        const outcome = await this.runElicitation(request.message, schema, USER_RESPONSE_TIMEOUT);
        if (outcome.action === 'accept') {
          return { action: 'accept', content: outcome.content };
        }
        return { action: outcome.action };
      },
      ...sessionOptions,
    };
  }

  private async resolveSessionOptions(workspaceDir: string, allowResume: boolean): Promise<Pick<Options, 'resume' | 'sessionId'>> {
    if (!allowResume) {
      const sessionId = randomUUID();
      this.currentSessionId = sessionId;
      return { sessionId };
    }

    const sessionId = this.getStableSessionId();
    const existing = await getSessionInfo(sessionId, { dir: workspaceDir }).catch(() => undefined);
    if (existing) {
      this.currentSessionId = existing.sessionId;
      return { resume: existing.sessionId };
    }

    this.currentSessionId = sessionId;
    return { sessionId };
  }

  private getStableSessionId(): string {
    const digest = createHash('sha256').update(`claude:${this.context.sessionKey}`).digest('hex');
    const part1 = digest.slice(0, 8);
    const part2 = digest.slice(8, 12);
    const part3 = `4${digest.slice(13, 16)}`;
    const variantNibble = ((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
    const part4 = `${variantNibble}${digest.slice(17, 20)}`;
    const part5 = digest.slice(20, 32);
    return `${part1}-${part2}-${part3}-${part4}-${part5}`;
  }

  private getPermissionMode(): PermissionMode {
    const raw = process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions';
    switch (raw) {
      case 'default':
      case 'acceptEdits':
      case 'bypassPermissions':
      case 'plan':
      case 'dontAsk':
      case 'auto':
        return raw;
      default:
        logger.log(`[${this.name}] Unknown CLAUDE_PERMISSION_MODE ${raw}, falling back to bypassPermissions`);
        return 'bypassPermissions';
    }
  }

  private getAdditionalDirectories(): string[] {
    const directories = new Set<string>();
    directories.add(path.resolve(this.context.workspaceDir));
    directories.add(path.resolve(process.cwd()));
    return [...directories];
  }

  private getMcpServers(): NonNullable<Options['mcpServers']> {
    const agent = process.env.AGENT || process.env.AGENT_NAME;

    return {
      discord: {
        command: 'npm',
        args: ['run', '--silent', 'mcp'],
        env: {
          ...(agent ? { AGENT: agent } : {}),
          KAEDE_SESSION_KEY: this.context.sessionKey,
          TEMPORARY_DIR: process.env.TEMPORARY_DIR || 'tmp',
        },
        alwaysLoad: true,
      },
    };
  }

  private getAllowedTools(): string[] {
    const configured = process.env.CLAUDE_ALLOWED_TOOLS?.split(',').map(tool => tool.trim()).filter(Boolean);
    const defaults = [
      'Bash',
      'Read',
      'Edit',
      'MultiEdit',
      'Glob',
      'Grep',
      'WebFetch',
      ...getClaudeDiscordAllowedTools(),
    ];

    const normalized = (configured && configured.length > 0 ? configured : defaults)
      .flatMap(tool => this.normalizeAllowedTool(tool));

    return [...new Set(normalized)];
  }

  private getDisallowedTools(): string[] {
    const configured = process.env.CLAUDE_DISALLOWED_TOOLS?.split(',').map(tool => tool.trim()).filter(Boolean) ?? [];
    return [...new Set(['AskUserQuestion', ...configured])];
  }

  private normalizeAllowedTool(tool: string): string[] {
    if (tool.startsWith('mcp__')) return [tool];
    if (tool.startsWith('Bash')) return ['Bash'];
    if (tool.startsWith('WebSearch') || tool.startsWith('WebFetch')) return ['WebFetch'];
    if (tool.startsWith('FileSystem')) return ['Read', 'Edit', 'MultiEdit'];
    if (tool.startsWith('Read') || tool.startsWith('View')) return ['Read'];
    if (tool.startsWith('Edit') || tool.startsWith('Write')) return ['Edit', 'MultiEdit'];
    if (tool.startsWith('Glob')) return ['Glob'];
    if (tool.startsWith('Grep') || tool.startsWith('Search')) return ['Grep'];
    return [tool];
  }

  private parseExtraArgs(raw: string): Record<string, string | null> {
    const tokens = raw.split(' ').map(token => token.trim()).filter(Boolean);
    const result: Record<string, string | null> = {};

    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (!token.startsWith('--')) continue;

      const body = token.slice(2);
      if (!body) continue;

      const eqIndex = body.indexOf('=');
      if (eqIndex >= 0) {
        result[body.slice(0, eqIndex)] = body.slice(eqIndex + 1);
        continue;
      }

      const next = tokens[index + 1];
      if (next && !next.startsWith('-')) {
        result[body] = next;
        index += 1;
      } else {
        result[body] = null;
      }
    }

    return result;
  }

  private buildPermissionPrompt(
    toolName: string,
    input: Record<string, unknown>,
    toolOptions: {
      title?: string;
      displayName?: string;
      description?: string;
      blockedPath?: string;
      decisionReason?: string;
    },
  ): string {
    const detail = this.formatToolDetail(this.normalizeToolName(toolName), input);
    const parts = [
      toolOptions.title || `Claude が ${toolOptions.displayName || toolName} の実行許可を求めています。`,
      toolOptions.description,
      toolOptions.blockedPath ? `対象: ${toolOptions.blockedPath}` : undefined,
      detail ? `詳細: ${detail}` : undefined,
      toolOptions.decisionReason,
    ].filter(Boolean);

    return parts.join('\n');
  }

  private formatResultError(errors: string[]): string {
    if (errors.length === 0) {
      return 'claude query failed during execution';
    }

    const summary = errors.join(' | ').trim();
    if (summary.toLowerCase().includes('authentication')) {
      return 'claude authentication failed. Please run claude login and try again.';
    }

    return summary;
  }

  private isModelSelectionErrorMessage(message: string): boolean {
    const lower = message.toLowerCase();
    return lower.includes('issue with the selected model')
      || lower.includes('run --model to pick a different model')
      || lower.includes('may not exist or you may not have access to it');
  }

  private describeAssistantError(error: string): string {
    switch (error) {
      case 'authentication_failed':
        return 'claude authentication failed. Please run claude login and try again.';
      case 'billing_error':
        return 'claude billing error. Check your Anthropic account or API provider settings.';
      case 'rate_limit':
        return 'claude rate limit exceeded. Please wait and try again.';
      default:
        return `claude returned an error: ${error}`;
    }
  }

  private toJsonSchemaShape(value: unknown): ElicitationSchema {
    if (!value || typeof value !== 'object') {
      return {};
    }

    const candidate = value as ElicitationSchema;
    return {
      properties: candidate.properties,
      required: Array.isArray(candidate.required) ? candidate.required : [],
    };
  }

  private handleAssistantToolUses(message: { message?: { content?: unknown } }, state: QueryState): void {
    const content = message.message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: string; name?: string; input?: Record<string, unknown> };
      if (b.type !== 'tool_use' || typeof b.name !== 'string') continue;

      const normalized = this.normalizeToolName(b.name);
      const detail = this.formatToolDetail(normalized, b.input ?? {});
      logger.log(`[${this.name}] tool: ${b.name}${detail ? ` | ${detail}` : ''}`);

      if (normalized === 'send_message') {
        state.sentDiscordMessage = true;
        this.context.messenger.stopTyping();
        continue;
      }

      this.context.messenger.setStatus(this.formatToolStatus(normalized, detail || undefined));
    }
  }

  private resolveEffort(options: ProviderOptions | undefined): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
    const raw = (options?.reasoningEffort || process.env.REASONING_EFFORT || '').trim().toLowerCase();
    if (raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh') return raw;
    return undefined;
  }
}