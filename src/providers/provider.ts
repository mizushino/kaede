import type { Messenger } from '../core/messenger.js';
import { logger } from '../core/logger.js';
import { STATUS_ICON } from '../core/status.js';

const STATUS_MAX_LENGTH = 88;

export interface ProviderOptions {
  model?: string;
  attachments?: string[];
}

export interface ProviderContext {
  channelId: string;
  messenger: Messenger;
  workspaceDir: string;
  sessionKey: string;
}

export abstract class BaseProvider {
  abstract readonly name: string;

  constructor(protected readonly context: ProviderContext) {}

  protected getIcon(): string {
    return '🤖';
  }

  protected getDisplayName(): string {
    return this.name;
  }

  protected formatToolStatus(toolName: string, detail?: string): string {
    const icon = STATUS_ICON[toolName] ?? '🤔';
    const raw = `${icon} ${toolName}${detail ? ` | ${detail}` : ''}`.trim();
    return raw.length > STATUS_MAX_LENGTH ? `${raw.slice(0, STATUS_MAX_LENGTH - 1)}…` : raw;
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

  async deleteSession(): Promise<void> {
    this.dispose();
  }

  sendToTerminal(text: string): void {
    logger.log(`[${this.name}] Ignoring provider input: ${text.slice(0, 80)}`);
  }

  dispose(): void {}
}