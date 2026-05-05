import path from 'path';
import { AcpProvider, listAcpModels } from './acp.js';

const DEFAULT_STATE_SUBDIR = 'acp-sessions';
const DEFAULT_APPROVAL_MODE = 'default';
const DEFAULT_CONTEXT_WINDOW = 1_048_576;
const DEFAULT_ACP_ARGS = ['--acp'];
const ACP_ENV_PREFIX = 'ACP_ENV_';

function parseArgs(raw: string | undefined, fallback: string[]): string[] {
  const tokens = (raw || '')
    .split(' ')
    .map(token => token.trim())
    .filter(Boolean);
  return tokens.length > 0 ? tokens : fallback;
}

function resolveCommand(): string {
  const configured = process.env.ACP_COMMAND?.trim();
  if (!configured) {
    throw new Error('ACP_COMMAND is not set. Set it to the path of the ACP CLI binary.');
  }
  return configured;
}

function buildArgs(): string[] {
  return parseArgs(process.env.ACP_ARGS, DEFAULT_ACP_ARGS);
}

function getContextWindow(): number {
  const raw = process.env.ACP_CONTEXT_WINDOW;
  if (!raw) return DEFAULT_CONTEXT_WINDOW;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_WINDOW;
}

function collectAcpEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(ACP_ENV_PREFIX) || typeof value !== 'string') continue;
    env[key.slice(ACP_ENV_PREFIX.length)] = value;
  }
  return env;
}

/**
 * Fully env-driven ACP provider. Useful for trying out new ACP-compatible CLIs
 * without writing a dedicated provider class. Configure via:
 *
 * - `ACP_COMMAND` (required) – CLI binary path
 * - `ACP_ARGS` – space-separated args (default: `--acp`)
 * - `ACP_NAME` – provider slug (default: `acp`)
 * - `ACP_DISPLAY_NAME` – display name (default: `ACP`)
 * - `ACP_ICON` – status icon emoji (default: 🤖)
 * - `ACP_STATE_SUBDIR` – session-state subdir under `TEMPORARY_DIR`
 * - `ACP_APPROVAL_MODE` – initial session mode (default: `default`)
 * - `ACP_CONTEXT_WINDOW` – context window in tokens (default: 1,048,576)
 * - `ACP_PROMPT_HEADING` – permission prompt heading
 * - `ACP_ENV_<NAME>` – extra env var passed to the CLI as `<NAME>`
 */
export class GenericAcpProvider extends AcpProvider {
  readonly name = (process.env.ACP_NAME?.trim() || 'acp');

  static async listModels(
    options: { workspaceDir?: string } = {},
  ): Promise<Array<{ id: string; displayName: string; description: string }>> {
    const workspaceDir = path.resolve(options.workspaceDir || process.cwd());
    return listAcpModels({
      command: resolveCommand(),
      args: buildArgs(),
      env: { ...process.env as Record<string, string>, ...collectAcpEnv() },
      cwd: workspaceDir,
      logTag: process.env.ACP_NAME?.trim() || 'acp',
    });
  }

  protected getIcon(): string {
    return process.env.ACP_ICON?.trim() || '🤖';
  }

  protected getDisplayName(): string {
    return process.env.ACP_DISPLAY_NAME?.trim() || 'ACP';
  }

  override getRuntimeLabel(): string {
    return `${this.getDisplayName()} (ACP)`;
  }

  protected resolveCommand(): string {
    return resolveCommand();
  }

  protected buildArgs(): string[] {
    return buildArgs();
  }

  protected getStateSubdir(): string {
    return process.env.ACP_STATE_SUBDIR?.trim() || DEFAULT_STATE_SUBDIR;
  }

  protected override getApprovalMode(): string {
    return (process.env.ACP_APPROVAL_MODE || DEFAULT_APPROVAL_MODE).trim();
  }

  protected getContextWindow(): number {
    return getContextWindow();
  }

  protected override getProviderEnv(): Record<string, string> {
    return collectAcpEnv();
  }

  protected override getPermissionPromptHeading(): string {
    const heading = process.env.ACP_PROMPT_HEADING?.trim();
    return heading || super.getPermissionPromptHeading();
  }
}
