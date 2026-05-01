import type { Messenger } from '../core/messenger.js';
import { logger } from '../core/logger.js';
import { STATUS_ICON } from '../core/status.js';

const STATUS_MAX_LENGTH = 88;

export interface ProviderOptions {
  model?: string;
  attachments?: string[];
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | '';
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
      case 'schedule_list':
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
      case 'schedule_add': {
        const cron = readString('cron');
        const description = readString('description', 'prompt');
        return cron && description ? `${cron} → ${description}` : cron || description;
      }
      case 'schedule_remove':
      case 'schedule_toggle':
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

  protected detectStructuredStatus(content: string): string | null {
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

  protected getEnvironmentVariables(): Record<string, string | undefined> {
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

  abstract sendPrompt(prompt: string, options?: ProviderOptions): Promise<void>;

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