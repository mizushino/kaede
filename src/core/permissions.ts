import type { PermissionRequest, PermissionRequestResult, PermissionHandler } from '@github/copilot-sdk';
import type { Messenger } from './messenger.js';
import { logger } from './logger.js';

export type PermissionKind = PermissionRequest['kind'];

const ALL_KINDS: PermissionKind[] = ['shell', 'write', 'mcp', 'read', 'url', 'custom-tool'];

export interface PermissionConfig {
  /** Permission kinds that are automatically approved without user interaction */
  autoApprove: Set<PermissionKind>;
  /** Timeout in ms for waiting for user reaction (default: 120s) */
  approvalTimeoutMs: number;
}

export function loadPermissionConfig(): PermissionConfig {
  const raw = process.env.PERMISSION_AUTO_APPROVE;

  let autoApprove: Set<PermissionKind>;
  if (raw === undefined || raw === '*' || raw === 'all') {
    // Unset: approve everything (backward-compatible)
    autoApprove = new Set(ALL_KINDS);
  } else if (raw === '') {
    // Explicitly empty: approve nothing (require approval for all)
    autoApprove = new Set();
  } else {
    const parsed = raw.split(',').map(s => s.trim()).filter(Boolean) as PermissionKind[];
    autoApprove = new Set(parsed);
  }

  const approvalTimeoutMs = Number(process.env.USER_RESPONSE_TIMEOUT_MS) || 300_000;

  return { autoApprove, approvalTimeoutMs };
}

/** Build a human-readable description of a permission request */
function describeRequest(request: PermissionRequest): string {
  const r = request as Record<string, unknown>;
  const detail = (keys: string[]) => {
    for (const k of keys) {
      if (r[k] !== undefined) return String(r[k]);
    }
    return null;
  };

  // Log the full request for debugging
  const { kind, toolCallId, ...rest } = r;
  logger.log(`[Permission] kind=${kind}`, JSON.stringify(rest).slice(0, 500));

  switch (request.kind) {
    case 'shell': {
      const cmd = detail(['fullCommandText', 'command', 'cmd']) ?? JSON.stringify(rest);
      return `🖥️ シェルコマンド実行\n\`${cmd.slice(0, 500)}\``;
    }
    case 'write': {
      const p = detail(['path', 'file', 'filePath']) ?? JSON.stringify(rest);
      return `📝 ファイル書き込み\nパス: \`${p}\``;
    }
    case 'read': {
      const p = detail(['path', 'file', 'filePath']) ?? JSON.stringify(rest);
      return `📖 ファイル読み取り\nパス: \`${p}\``;
    }
    case 'url': {
      const u = detail(['url', 'uri']) ?? JSON.stringify(rest);
      return `🌐 URL アクセス\nURL: \`${u}\``;
    }
    case 'mcp': {
      const tool = detail(['toolName', 'tool', 'name']) ?? JSON.stringify(rest);
      return `🔧 MCP ツール呼び出し\nツール: \`${tool}\``;
    }
    case 'custom-tool': {
      const tool = detail(['toolName', 'tool', 'name']) ?? JSON.stringify(rest);
      return `⚙️ カスタムツール\nツール: \`${tool}\``;
    }
    default:
      return `❓ 不明な操作 (${request.kind})\n${JSON.stringify(rest).slice(0, 300)}`;
  }
}

/**
 * Create a PermissionHandler that checks config and optionally asks the user
 * for approval via Messenger (Discord reactions etc.)
 */
export function createPermissionHandler(
  messenger: Messenger,
  config: PermissionConfig,
): PermissionHandler {
  return async (request: PermissionRequest): Promise<PermissionRequestResult> => {
    // Auto-approve if this kind is in the allow list
    if (config.autoApprove.has(request.kind)) {
      return { kind: 'approved' };
    }

    // Ask user for approval via platform (e.g. Discord reactions)
    const prompt = describeRequest(request);

    try {
      const approved = await messenger.requestApproval(prompt, config.approvalTimeoutMs);
      if (approved) {
        return { kind: 'approved' };
      }
      return { kind: 'denied-interactively-by-user', feedback: 'User denied via reaction' };
    } catch {
      return { kind: 'denied-interactively-by-user', feedback: 'Approval timed out' };
    }
  };
}
