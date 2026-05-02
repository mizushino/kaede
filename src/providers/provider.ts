import type { Messenger } from '../core/messenger.js';
import { logger } from '../core/logger.js';
import { STATUS_ICON } from '../core/status.js';

const STATUS_MAX_LENGTH = 88;

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface ProviderOptions {
  model?: string;
  attachments?: string[];
  reasoningEffort?: ReasoningEffort | '';
}

export interface ProviderContext {
  channelId: string;
  messenger: Messenger;
  workspaceDir: string;
  sessionKey: string;
}

export type ElicitationSchemaProperty = {
  title?: string;
  description?: string;
  type?: string;
  enum?: string[];
  oneOf?: Array<{ const?: string; title?: string }>;
  default?: unknown;
};

export type ElicitationSchema = {
  properties?: Record<string, ElicitationSchemaProperty>;
  required?: string[];
};

export type ElicitationOutcome =
  | { action: 'accept'; content: Record<string, string | number | boolean> }
  | { action: 'cancel' }
  | { action: 'decline' };

export abstract class BaseProvider {
  abstract readonly name: string;

  constructor(protected readonly context: ProviderContext) {}

  protected getIcon(): string {
    return '🤖';
  }

  protected getDisplayName(): string {
    return this.name;
  }

  getRuntimeLabel(): string {
    return this.getDisplayName();
  }

  protected formatToolStatus(toolName: string, detail?: string): string {
    const icon = STATUS_ICON[toolName] ?? '🤔';
    const raw = `${icon} ${toolName}${detail ? ` | ${detail}` : ''}`.trim();
    return raw.length > STATUS_MAX_LENGTH ? `${raw.slice(0, STATUS_MAX_LENGTH - 1)}…` : raw;
  }

  protected normalizeToolName(toolName: string): string {
    if (toolName.startsWith('mcp__discord__')) {
      return toolName.slice('mcp__discord__'.length);
    }

    switch (toolName) {
      case 'Bash':
        return 'bash';
      case 'Read':
      case 'View':
        return 'view';
      case 'Edit':
      case 'MultiEdit':
      case 'Write':
        return 'edit';
      case 'Glob':
        return 'glob';
      case 'Grep':
      case 'Search':
        return 'grep';
      case 'WebFetch':
      case 'WebSearch':
        return 'web_fetch';
      case 'Task':
        return 'report_intent';
      default:
        return toolName;
    }
  }

  protected formatToolDetail(toolName: string, input: Record<string, unknown>): string {
    const readString = (...keys: string[]): string => {
      for (const key of keys) {
        const value = input[key];
        if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 120);
      }
      return '';
    };

    switch (toolName) {
      case 'bash':
        return readString('command');
      case 'view':
      case 'create':
      case 'edit':
        return readString('file_path', 'path');
      case 'glob':
      case 'grep':
        return readString('pattern');
      case 'web_fetch':
        return readString('url');
      case 'send_message':
        return readString('content');
      case 'ask_user':
        return readString('question', 'channelId');
      case 'list_funcs':
      case 'list_schedules':
        return '';
      case 'read_func':
      case 'write_func':
      case 'delete_func':
        return readString('filename');
      case 'run_func': {
        const filename = readString('filename');
        const tool = typeof input.tool === 'string' ? input.tool : '';
        return `${filename}${tool ? `:${tool}` : ''}`;
      }
      case 'add_schedule': {
        const cron = readString('cron');
        const description = readString('description', 'prompt');
        return cron && description ? `${cron} → ${description}` : cron || description;
      }
      case 'remove_schedule':
      case 'toggle_schedule':
        return readString('id');
      case 'get_messages':
      case 'get_channels':
      case 'get_servers':
        return readString('channelId', 'serverId');
      default:
        return Object.keys(input).length ? JSON.stringify(input).slice(0, 120) : '';
    }
  }

  protected async runElicitation(
    message: string,
    schema: ElicitationSchema,
    timeoutMs: number,
  ): Promise<ElicitationOutcome> {
    const fields = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const fieldNames = Object.keys(fields);

    if (fieldNames.length === 0) {
      const approved = await this.context.messenger.requestApproval(message, timeoutMs);
      return approved ? { action: 'accept', content: {} } : { action: 'decline' };
    }

    const stringDefault = (value: unknown): string => (typeof value === 'string' ? value : '');
    const content: Record<string, string | number | boolean> = {};

    for (const fieldName of fieldNames) {
      const field = fields[fieldName];
      const title = field.title ?? fieldName;
      const description = field.description ? `\n${field.description}` : '';
      const isRequired = required.has(fieldName);
      const suffix = isRequired ? ' (必須)' : ' (任意)';
      const prompt = `${message}\n\n**${title}**${suffix}${description}`;

      if (field.type === 'boolean') {
        content[fieldName] = await this.context.messenger.requestApproval(prompt, timeoutMs);
        continue;
      }

      if (Array.isArray(field.enum) && field.enum.length > 0) {
        const { answer } = await this.context.messenger.requestUserInput(prompt, field.enum, true);
        if (!answer && isRequired) return { action: 'cancel' };
        content[fieldName] = answer || stringDefault(field.default);
        continue;
      }

      if (Array.isArray(field.oneOf) && field.oneOf.length > 0) {
        const choices = field.oneOf
          .map(option => option.title ?? option.const ?? '')
          .filter((value): value is string => Boolean(value));
        const { answer } = await this.context.messenger.requestUserInput(prompt, choices, true);
        if (!answer && isRequired) return { action: 'cancel' };
        const selected = field.oneOf.find(option => (option.title ?? option.const ?? '') === answer);
        content[fieldName] = selected?.const ?? answer ?? stringDefault(field.default);
        continue;
      }

      const { answer } = await this.context.messenger.requestUserInput(prompt);
      if (!answer && isRequired) return { action: 'cancel' };

      if (field.type === 'number' || field.type === 'integer') {
        content[fieldName] = Number(answer || field.default || 0);
      } else {
        content[fieldName] = answer || stringDefault(field.default);
      }
    }

    return { action: 'accept', content };
  }

  abstract sendPrompt(prompt: string, options?: ProviderOptions): Promise<void>;

  /** Reset session-level state when the agent's model changes. */
  async setModel(): Promise<void> {}

  getRemainingTurnTimeMs(): number | null {
    return null;
  }

  async deleteSession(): Promise<void> {
    this.dispose();
  }

  sendToTerminal(text: string): void {
    logger.log(`[${this.name}] Ignoring provider input: ${text.slice(0, 80)}`);
  }

  dispose(): void {}
}