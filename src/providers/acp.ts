import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { Readable, Writable } from 'stream';
import * as acp from '@agentclientprotocol/sdk';
import { BaseProvider, normalizeToolName } from './provider.js';
import type { ContextUsageInfo, ProviderOptions } from './provider.js';
import { logger } from '../core/logger.js';
import { loadPermissionConfig, type PermissionConfig, type PermissionKind } from '../core/permissions.js';

const DEFAULT_TEMPORARY_DIR = path.resolve(process.env.TEMPORARY_DIR || 'tmp');

export type SessionOpenResponse = acp.NewSessionResponse | acp.LoadSessionResponse;

export interface PersistedSessionState {
  sessionId: string;
  currentModel?: string;
}

export interface ToolSnapshot {
  kind?: acp.ToolKind | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  status?: acp.ToolCallStatus | null;
  title?: string | null;
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const normalizedTarget = path.resolve(targetPath);
  const normalizedRoot = path.resolve(rootPath);
  if (normalizedTarget === normalizedRoot) return true;
  return normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of paths.map(value => path.resolve(value))) {
    if (!seen.has(entry)) {
      seen.add(entry);
      result.push(entry);
    }
  }
  return result;
}

function truncate(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function readStringProperty(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

const KNOWN_TOOL_NAMES = [
  'send_message', 'ask_user', 'get_messages', 'get_channels', 'report_intent',
  'write_func', 'read_func', 'delete_func', 'run_func', 'list_funcs',
  'add_schedule', 'list_schedules', 'remove_schedule',
  'web_fetch', 'web_search', 'glob', 'grep', 'view', 'edit', 'bash',
];

function detectToolNameFromText(text: string): string | null {
  const tokens = text.match(/\b([a-z_][a-z0-9_]*)\b/gi);
  if (!tokens) return null;
  for (const token of tokens) {
    const stripped = normalizeToolName(token);
    if (KNOWN_TOOL_NAMES.includes(stripped)) {
      return stripped === 'web_search' ? 'web_fetch' : stripped;
    }
  }
  return null;
}

function readToolNameFromPayload(value: unknown, depth = 0): string | null {
  if (depth > 2 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = readToolNameFromPayload(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const named = readStringProperty(record, 'toolName', 'tool', 'name', 'command');
  if (named) return named;
  for (const entry of Object.values(record)) {
    const found = readToolNameFromPayload(entry, depth + 1);
    if (found) return found;
  }
  return null;
}

function detectToolNameFromPayload(value: unknown, depth = 0): string | null {
  if (depth > 2 || value == null) return null;
  if (typeof value === 'string') return detectToolNameFromText(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const detected = detectToolNameFromPayload(item, depth + 1);
      if (detected) return detected;
    }
    return null;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const named = readStringProperty(record, 'toolName', 'tool', 'name', 'command');
    if (named) {
      const stripped = normalizeToolName(named);
      const detected = detectToolNameFromText(stripped);
      if (detected) return detected;
      return stripped;
    }
    for (const entry of Object.values(record)) {
      const detected = detectToolNameFromPayload(entry, depth + 1);
      if (detected) return detected;
    }
  }
  return null;
}

function buildAdditionalDirectories(cwd: string): string[] {
  return uniquePaths([
    path.resolve(process.cwd()),
    DEFAULT_TEMPORARY_DIR,
  ]).filter(entry => entry !== cwd);
}

function buildDiscordMcpServer(sessionKey: string): acp.McpServerStdio {
  const repoRoot = path.resolve(process.cwd());
  const agent = process.env.AGENT || process.env.AGENT_NAME || '';
  const env: acp.EnvVariable[] = [
    { name: 'KAEDE_SESSION_KEY', value: sessionKey },
    { name: 'TEMPORARY_DIR', value: process.env.TEMPORARY_DIR || 'tmp' },
  ];
  if (agent) env.push({ name: 'AGENT', value: agent });
  if (process.env.PATH) env.push({ name: 'PATH', value: process.env.PATH });
  if (process.env.HOME) env.push({ name: 'HOME', value: process.env.HOME });

  return {
    name: 'discord',
    command: 'npm',
    args: ['run', '--silent', '--prefix', repoRoot, 'mcp'],
    env,
  };
}

function getSessionStateFilePath(subdir: string, sessionKey: string): string {
  const safe = encodeURIComponent(sessionKey);
  return path.join(DEFAULT_TEMPORARY_DIR, subdir, `${safe}.json`);
}

export interface AcpSpawnConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** Tag used in log lines (e.g. "gemini"). Defaults to the basename of `command`. */
  logTag?: string;
}

function formatSpawnError(command: string, err: unknown): Error {
  const error = err instanceof Error ? err : new Error(String(err));
  const code = (error as Error & { code?: string }).code;
  if (code === 'ENOENT') {
    return new Error(`ACP CLI not found (tried: ${command}).`);
  }
  return new Error(`Failed to start ACP CLI (${command}): ${error.message}`);
}

const liveAcpChildren = new Set<ChildProcessWithoutNullStreams>();
let killAllHookInstalled = false;

function installKillAllHook(): void {
  if (killAllHookInstalled) return;
  killAllHookInstalled = true;
  const killAll = () => {
    for (const child of liveAcpChildren) {
      killProcessGroup(child, 'SIGKILL');
    }
    liveAcpChildren.clear();
  };
  process.on('exit', killAll);
}

function trackAcpChild(child: ChildProcessWithoutNullStreams): void {
  installKillAllHook();
  liveAcpChildren.add(child);
}

function untrackAcpChild(child: ChildProcessWithoutNullStreams): void {
  liveAcpChildren.delete(child);
}

/** Force-kill every tracked ACP child and its pgroup. Used on hard shutdown. */
export function killAllAcpChildren(): void {
  for (const child of liveAcpChildren) {
    killProcessGroup(child, 'SIGKILL');
  }
  liveAcpChildren.clear();
}

/**
 * Send a signal to the child's whole process group when possible (so MCP
 * servers / grandchildren spawned by the ACP CLI are also killed). Falls back
 * to a direct child kill when the pgroup is unknown.
 */
function killProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.killed) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* ignore */ }
  }
}

/**
 * Terminate an ACP child cleanly: close stdin, send SIGTERM to the process
 * group, then SIGKILL after a grace period if it is still alive. Resolves
 * when the child has exited (or after the kill timeout).
 */
async function terminateAcpChild(
  child: ChildProcessWithoutNullStreams,
  graceMs = 3000,
): Promise<void> {
  if (child.exitCode !== null) {
    untrackAcpChild(child);
    return;
  }
  try { child.stdin.end(); } catch { /* ignore */ }
  killProcessGroup(child, 'SIGTERM');

  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      killProcessGroup(child, 'SIGKILL');
    }, graceMs);
    timer.unref?.();
    const finalTimer = setTimeout(() => resolve(), graceMs + 2000);
    finalTimer.unref?.();
    child.once('exit', () => {
      clearTimeout(timer);
      clearTimeout(finalTimer);
      resolve();
    });
  });
  untrackAcpChild(child);
}

export async function spawnAcpConnection<TClient extends acp.Client>(
  client: TClient,
  config: AcpSpawnConfig,
): Promise<{
  child: ChildProcessWithoutNullStreams;
  connection: acp.ClientSideConnection;
}> {
  const tag = config.logTag || path.basename(config.command);
  const child = spawn(config.command, config.args, {
    cwd: config.cwd,
    env: config.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });

  trackAcpChild(child);
  child.once('exit', () => untrackAcpChild(child));

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    const text = String(chunk).trim();
    if (text) logger.log(`[${tag}] ${text}`);
  });

  child.once('exit', (code, signal) => {
    logger.log(`[${tag}] process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
  });

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const connection = new acp.ClientSideConnection(() => client, stream);

  const spawnError = new Promise<never>((_, reject) => {
    child.once('error', err => reject(formatSpawnError(config.command, err)));
  });

  await Promise.race([
    connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
      clientInfo: { name: 'kaede', version: '1.0.0' },
    }),
    spawnError,
  ]);

  return { child, connection };
}

/**
 * Generic ACP-based provider. Handles connection lifecycle, session
 * persistence, MCP tool trust, file IO, status/usage forwarding. Subclasses
 * provide the CLI command + env + per-provider quirks (usage extraction,
 * context window, approval mode env name, etc.).
 */
export abstract class AcpProvider extends BaseProvider implements acp.Client {
  protected child?: ChildProcessWithoutNullStreams;
  protected connection?: acp.ClientSideConnection;
  protected sessionId: string | null = null;
  protected currentModelId = '';
  protected currentModeId = '';
  protected currentUsage: ContextUsageInfo | null = null;
  protected currentAbort = false;

  protected readonly cwd = path.resolve(this.context.workspaceDir);
  protected readonly additionalDirectories = buildAdditionalDirectories(this.cwd);
  protected readonly allowedRoots = uniquePaths([this.cwd, ...this.additionalDirectories]);
  protected readonly toolSnapshots = new Map<string, ToolSnapshot>();
  protected readonly permissionConfig: PermissionConfig = loadPermissionConfig();

  /** CLI binary path (e.g. "gemini"). */
  protected abstract resolveCommand(): string;
  /** CLI args including the ACP entrypoint flag. */
  protected abstract buildArgs(): string[];
  /** Subdirectory under TEMPORARY_DIR for session state files. */
  protected abstract getStateSubdir(): string;
  /** Optional default approval mode (e.g. "default", "yolo"). */
  protected getApprovalMode(): string {
    return 'default';
  }
  /** Maximum context window for the given model id (in tokens). */
  protected abstract getContextWindow(modelId: string): number;
  /**
   * Extract `(used, modelId)` from a prompt response. Default implementation
   * uses the standard ACP `response.usage.totalTokens`. Override when the
   * provider stuffs usage into `_meta`.
   */
  protected extractUsageFromResponse(response: acp.PromptResponse): { used: number; modelId: string } | null {
    const used = response.usage?.totalTokens;
    if (typeof used !== 'number') return null;
    return { used, modelId: this.currentModelId };
  }
  /** Extra environment vars on top of the spawned process's PATH/HOME etc. */
  protected getProviderEnv(): Record<string, string> {
    return {};
  }
  /** MCP servers to attach to each ACP session. */
  protected getMcpServers(): acp.McpServerStdio[] {
    return [buildDiscordMcpServer(this.context.sessionKey)];
  }
  /** Permission-prompt heading. */
  protected getPermissionPromptHeading(): string {
    return `${this.getDisplayName()} がこの操作の許可を求めています。`;
  }

  override async getContextUsage(): Promise<ContextUsageInfo | null> {
    return this.currentUsage;
  }

  sendToTerminal(text: string): void {
    if (text.includes('\u0003') || text.includes('\x03')) {
      if (this.sessionId && this.connection && !this.currentAbort) {
        this.currentAbort = true;
        void this.connection.cancel({ sessionId: this.sessionId }).catch(err => {
          logger.error(`[${this.name}] Failed to cancel prompt:`, err);
        }).finally(() => {
          this.currentAbort = false;
        });
      }
      return;
    }
    super.sendToTerminal(text);
  }

  async dispose(): Promise<void> {
    await this.shutdownConnection();
    super.dispose();
  }

  override async deleteSession(): Promise<void> {
    await this.shutdownConnection();
    this.sessionId = null;
    this.currentModelId = '';
    this.currentUsage = null;
    await this.clearPersistedSessionState();
  }

  async setModel(): Promise<void> {
    if (!this.connection || !this.sessionId) return;
    await this.applySessionOptions(this.connection, { model: process.env.AGENT_MODEL });
  }

  async sendPrompt(prompt: string, options?: ProviderOptions): Promise<void> {
    try {
      const connection = await this.ensureConnection();
      await this.ensureSession(connection, options);

      if (!this.sessionId) {
        throw new Error(`${this.name} ACP session was not created.`);
      }

      const response = await connection.prompt({
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: prompt }],
      });

      if (response.stopReason === 'cancelled') {
        throw new Error(`${this.name} prompt cancelled`);
      }

      this.updateUsage(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const lower = message.toLowerCase();
      if (lower.includes('api key') || lower.includes('authentication')) {
        throw new Error(`${this.name} authentication failed: ${message}`);
      }
      throw err instanceof Error ? err : new Error(message);
    } finally {
      this.toolSnapshots.clear();
      this.context.messenger.clearStatus();
      this.context.messenger.stopTyping();
    }
  }

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    if (this.isTrustedMcpTool(params.toolCall) || this.isAutoApproved(params.toolCall)) {
      const auto = params.options.find(option => option.kind === 'allow_always')
        ?? params.options.find(option => option.kind === 'allow_once')
        ?? params.options[0];
      if (auto) {
        return { outcome: { outcome: 'selected', optionId: auto.optionId } };
      }
    }

    const toolName = this.describeToolName(params.toolCall);
    const detail = this.describeToolDetail(toolName, params.toolCall);
    const choices = params.options.map(option => option.name);
    const prompt = [
      this.getPermissionPromptHeading(),
      `**${toolName}**${detail ? `\n${detail}` : ''}`,
    ].join('\n\n');

    try {
      const { answer } = await this.context.messenger.requestUserInput(prompt, choices, false);
      const selected = params.options.find(option => option.name === answer)
        ?? params.options.find(option => option.kind === 'reject_once')
        ?? params.options[0];

      if (!selected) return { outcome: { outcome: 'cancelled' } };

      return {
        outcome: { outcome: 'selected', optionId: selected.optionId },
      };
    } catch (err) {
      logger.error(`[${this.name}] Permission prompt failed:`, err);
      return { outcome: { outcome: 'cancelled' } };
    }
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;

    switch (update.sessionUpdate) {
      case 'plan':
      case 'agent_thought_chunk':
        this.context.messenger.setStatus(this.formatToolStatus('report_intent'));
        return;

      case 'usage_update': {
        const percentage = update.size > 0 ? Math.round((update.used / update.size) * 1000) / 10 : 0;
        this.currentUsage = {
          totalTokens: update.used,
          maxTokens: update.size,
          percentage,
          model: this.currentModelId || undefined,
          categories: [],
        };
        return;
      }

      case 'current_mode_update':
        this.currentModeId = update.currentModeId;
        return;

      case 'tool_call':
        this.toolSnapshots.set(update.toolCallId, {
          kind: update.kind,
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
          status: update.status,
          title: update.title,
        });
        this.handleToolProgress(update);
        return;

      case 'tool_call_update': {
        const snapshot = this.toolSnapshots.get(update.toolCallId) ?? {};
        const merged: ToolSnapshot = {
          kind: update.kind ?? snapshot.kind,
          rawInput: update.rawInput ?? snapshot.rawInput,
          rawOutput: update.rawOutput ?? snapshot.rawOutput,
          status: update.status ?? snapshot.status,
          title: update.title ?? snapshot.title,
        };
        this.toolSnapshots.set(update.toolCallId, merged);
        this.handleToolProgress(merged);
        return;
      }

      default:
        return;
    }
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const targetPath = this.validateFilePath(params.path);

    let content: string;
    try {
      content = await fs.readFile(targetPath, 'utf8');
    } catch {
      throw acp.RequestError.resourceNotFound(targetPath);
    }

    const line = params.line ?? 1;
    const limit = params.limit ?? null;
    if (line <= 1 && limit == null) return { content };

    const lines = content.split(/\r?\n/);
    const start = Math.max(0, line - 1);
    const end = limit == null ? lines.length : Math.max(start, start + limit);
    return { content: lines.slice(start, end).join('\n') };
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    const targetPath = this.validateFilePath(params.path);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, params.content, 'utf8');
    return {};
  }

  protected getProcessEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value;
    }
    env.PATH = process.env.PATH ?? '';
    env.HOME = process.env.HOME ?? '';
    env.USER = process.env.USER ?? '';
    env.SHELL = process.env.SHELL ?? '/bin/bash';
    env.TERM = 'dumb';
    env.FORCE_COLOR = '0';
    env.CLICOLOR = '0';
    env.NO_COLOR = '1';
    Object.assign(env, this.getProviderEnv());
    return env;
  }

  protected async ensureConnection(): Promise<acp.ClientSideConnection> {
    if (this.connection) return this.connection;
    const launched = await spawnAcpConnection(this, {
      command: this.resolveCommand(),
      args: this.buildArgs(),
      env: this.getProcessEnv(),
      cwd: this.cwd,
      logTag: this.name,
    });
    this.child = launched.child;
    this.connection = launched.connection;
    return this.connection;
  }

  protected async ensureSession(
    connection: acp.ClientSideConnection,
    options?: ProviderOptions,
  ): Promise<void> {
    if (!this.sessionId) {
      const persisted = await this.loadPersistedSessionState();
      const mcpServers = this.getMcpServers();

      if (persisted?.sessionId) {
        try {
          const response = await connection.loadSession({
            sessionId: persisted.sessionId,
            cwd: this.cwd,
            additionalDirectories: this.additionalDirectories,
            mcpServers,
          });
          this.sessionId = persisted.sessionId;
          this.currentModelId = persisted.currentModel || response.models?.currentModelId || '';
          this.applySessionMetadata(response);
          logger.log(`[${this.name}] Loaded ACP session ${this.sessionId}`);
        } catch (err) {
          logger.log(`[${this.name}] Failed to load saved ACP session, creating a new one: ${(err as Error).message}`);
          await this.clearPersistedSessionState();
        }
      }

      if (!this.sessionId) {
        const response = await connection.newSession({
          cwd: this.cwd,
          additionalDirectories: this.additionalDirectories,
          mcpServers,
        });
        this.sessionId = response.sessionId;
        this.currentModelId = response.models?.currentModelId || '';
        this.applySessionMetadata(response);
        await this.persistSessionState();
        logger.log(`[${this.name}] Created ACP session ${this.sessionId}`);
      }
    }

    await this.applySessionOptions(connection, options);
  }

  protected applySessionMetadata(response: SessionOpenResponse): void {
    this.currentModeId = response.modes?.currentModeId || this.currentModeId;
    if (response.models?.currentModelId) {
      this.currentModelId = response.models.currentModelId;
    }
  }

  protected async applySessionOptions(
    connection: acp.ClientSideConnection,
    options?: ProviderOptions,
  ): Promise<void> {
    if (!this.sessionId) return;

    const targetMode = this.getApprovalMode().trim();
    if (targetMode && targetMode !== this.currentModeId) {
      await connection.setSessionMode({
        sessionId: this.sessionId,
        modeId: targetMode,
      });
      this.currentModeId = targetMode;
    }

    const targetModel = options?.model?.trim();
    if (targetModel && targetModel !== this.currentModelId) {
      await connection.unstable_setSessionModel({
        sessionId: this.sessionId,
        modelId: targetModel,
      });
      this.currentModelId = targetModel;
      await this.persistSessionState();
    }
  }

  protected updateUsage(response: acp.PromptResponse): void {
    const extracted = this.extractUsageFromResponse(response);
    if (!extracted) return;

    const max = this.getContextWindow(extracted.modelId);
    this.currentUsage = {
      totalTokens: extracted.used,
      maxTokens: max,
      percentage: max > 0 ? Math.round((extracted.used / max) * 1000) / 10 : 0,
      model: extracted.modelId || undefined,
      categories: [],
    };
  }

  protected async shutdownConnection(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.connection = undefined;
    if (child) {
      await terminateAcpChild(child);
    }
  }

  protected handleToolProgress(update: ToolSnapshot): void {
    const toolName = this.describeToolName(update);
    const detail = this.describeToolDetail(toolName, update);

    if (toolName === 'send_message') {
      this.context.messenger.stopTyping();
    }

    this.context.messenger.setStatus(this.formatToolStatus(toolName, detail || undefined));
  }

  protected isTrustedMcpTool(update: ToolSnapshot): boolean {
    const rawName = readToolNameFromPayload(update.rawInput)
      || readToolNameFromPayload(update.rawOutput)
      || '';
    if (rawName.startsWith('discord__')
      || rawName.startsWith('discord.')
      || rawName.startsWith('discord:')
      || rawName.startsWith('mcp__discord__')) {
      return true;
    }
    const title = update.title || '';
    return /\(discord MCP Server\)/i.test(title);
  }

  protected isAutoApproved(update: ToolSnapshot): boolean {
    if (this.permissionConfig.approveAll) return true;
    const kind = this.mapToolKindToPermission(update);
    if (!kind) return false;
    return this.permissionConfig.autoApprove.has(kind);
  }

  protected mapToolKindToPermission(update: ToolSnapshot): PermissionKind | null {
    switch (update.kind) {
      case 'execute': return 'shell';
      case 'read': return 'read';
      case 'search': return 'read';
      case 'edit':
      case 'delete':
      case 'move': return 'write';
      case 'fetch': return 'url';
      case 'think':
      case 'switch_mode': return null;
      case 'other':
      default: {
        const rawName = readToolNameFromPayload(update.rawInput)
          || readToolNameFromPayload(update.rawOutput)
          || '';
        return rawName ? 'mcp' : 'custom-tool';
      }
    }
  }

  protected describeToolName(update: ToolSnapshot): string {
    const explicitName = detectToolNameFromPayload(update.rawInput)
      || detectToolNameFromPayload(update.rawOutput)
      || detectToolNameFromText(update.title || '');

    if (explicitName) return this.normalizeToolName(explicitName);

    switch (update.kind) {
      case 'execute': return 'bash';
      case 'read': return 'view';
      case 'edit':
      case 'delete':
      case 'move': return 'edit';
      case 'search': return 'grep';
      case 'fetch': return 'web_fetch';
      case 'think':
      case 'switch_mode':
      case 'other':
      default: return 'report_intent';
    }
  }

  protected describeToolDetail(toolName: string, update: ToolSnapshot): string {
    const input = this.extractDetailSource(update.rawInput);
    if (input) {
      return this.formatToolDetail(toolName, input);
    }
    return truncate(update.title || '');
  }

  protected extractDetailSource(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.arguments && typeof record.arguments === 'object' && !Array.isArray(record.arguments)) {
      return record.arguments as Record<string, unknown>;
    }
    return record;
  }

  protected validateFilePath(targetPath: string): string {
    if (!path.isAbsolute(targetPath)) {
      throw new acp.RequestError(-32602, `ACP file paths must be absolute: ${targetPath}`);
    }
    const resolved = path.resolve(targetPath);
    const allowed = this.allowedRoots.some(root => isWithinRoot(resolved, root));
    if (!allowed) {
      throw new acp.RequestError(-32602, `Path is outside the allowed workspace roots: ${resolved}`);
    }
    return resolved;
  }

  protected async loadPersistedSessionState(): Promise<PersistedSessionState | null> {
    try {
      const raw = await fs.readFile(getSessionStateFilePath(this.getStateSubdir(), this.context.sessionKey), 'utf8');
      return JSON.parse(raw) as PersistedSessionState;
    } catch {
      return null;
    }
  }

  protected async persistSessionState(): Promise<void> {
    if (!this.sessionId) return;
    const filePath = getSessionStateFilePath(this.getStateSubdir(), this.context.sessionKey);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({
      sessionId: this.sessionId,
      currentModel: this.currentModelId || undefined,
    }), 'utf8');
  }

  protected async clearPersistedSessionState(): Promise<void> {
    try {
      await fs.unlink(getSessionStateFilePath(this.getStateSubdir(), this.context.sessionKey));
    } catch {
      /* ignore */
    }
  }
}

/**
 * Helper for static `listModels()` implementations: spawns a throwaway ACP
 * session, calls `newSession`, and returns the model list (or empty on failure).
 */
export async function listAcpModels(
  config: AcpSpawnConfig,
): Promise<Array<{ id: string; displayName: string; description: string }>> {
  class NullClient implements acp.Client {
    async requestPermission(_params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
      return { outcome: { outcome: 'cancelled' } };
    }
    async sessionUpdate(_params: acp.SessionNotification): Promise<void> {}
  }

  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const launched = await spawnAcpConnection(new NullClient(), config);
    child = launched.child;

    const response = await launched.connection.newSession({
      cwd: config.cwd,
      additionalDirectories: buildAdditionalDirectories(config.cwd),
      mcpServers: [],
    });

    const models: Array<{ modelId: string; name: string; description?: string | null }> =
      response.models?.availableModels ?? [];

    return models.map(model => ({
      id: model.modelId,
      displayName: model.name,
      description: model.description ?? '',
    }));
  } catch (err) {
    logger.error(`[${config.logTag || 'acp'}] Failed to list models via ACP:`, err);
    return [];
  } finally {
    if (child) {
      await terminateAcpChild(child);
    }
  }
}
