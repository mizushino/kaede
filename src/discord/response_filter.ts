import fs from 'fs';
import path from 'path';
import type { Message } from 'discord.js';
import { logger } from '../core/logger.js';

export type ResponseMode = 'all' | 'mention' | 'keyword';

const VALID_MODES: ResponseMode[] = ['all', 'mention', 'keyword'];

export function isResponseMode(value: string): value is ResponseMode {
  return (VALID_MODES as string[]).includes(value);
}

interface OverridesFile {
  [channelId: string]: ResponseMode;
}

export class ResponseFilter {
  private readonly defaultMode: ResponseMode;
  private readonly keywords: string[];
  private readonly overridesPath: string;
  private overrides: OverridesFile = {};

  constructor(configDir: string) {
    const rawMode = (process.env.RESPONSE_MODE || 'all').toLowerCase();
    this.defaultMode = isResponseMode(rawMode) ? rawMode : 'all';

    const explicit = (process.env.RESPONSE_KEYWORDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    if (explicit.length === 0) {
      const agentName = (process.env.AGENT_NAME || '').trim();
      if (agentName) explicit.push(agentName);
    }
    this.keywords = explicit.map(k => k.toLowerCase());

    this.overridesPath = path.join(configDir, 'response.json');
    this.load();

    logger.log(`[FILTER] Default mode: ${this.defaultMode} | keywords: ${this.keywords.join(',') || '(none)'}`);
    if (this.keywords.length === 0 && this.usesKeywordMode()) {
      logger.error('[FILTER] WARNING: keyword mode is configured but no RESPONSE_KEYWORDS / AGENT_NAME provided. Non-mention messages will be ignored.');
    }
  }

  private usesKeywordMode(): boolean {
    if (this.defaultMode === 'keyword') return true;
    return Object.values(this.overrides).includes('keyword');
  }

  private load(): void {
    try {
      if (fs.existsSync(this.overridesPath)) {
        const raw = JSON.parse(fs.readFileSync(this.overridesPath, 'utf-8')) as OverridesFile;
        const cleaned: OverridesFile = {};
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === 'string' && isResponseMode(v)) cleaned[k] = v;
        }
        this.overrides = cleaned;
      }
    } catch (err) {
      logger.error('[FILTER] Failed to load overrides:', err);
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.overridesPath, JSON.stringify(this.overrides, null, 2));
    } catch (err) {
      logger.error('[FILTER] Failed to save overrides:', err);
    }
  }

  getEffectiveMode(channelId: string): ResponseMode {
    return this.overrides[channelId] ?? this.defaultMode;
  }

  getDefaultMode(): ResponseMode {
    return this.defaultMode;
  }

  getOverride(channelId: string): ResponseMode | undefined {
    return this.overrides[channelId];
  }

  getKeywords(): string[] {
    return [...this.keywords];
  }

  setOverride(channelId: string, mode: ResponseMode): void {
    this.overrides[channelId] = mode;
    this.save();
    if (mode === 'keyword' && this.keywords.length === 0) {
      logger.error(`[FILTER] WARNING: channel ${channelId} set to keyword mode but no keywords are configured. Non-mention messages will be ignored.`);
    }
  }

  clearOverride(channelId: string): boolean {
    if (!(channelId in this.overrides)) return false;
    delete this.overrides[channelId];
    this.save();
    return true;
  }

  shouldRespond(message: Message, botUserId: string): boolean {
    const mode = this.getEffectiveMode(message.channel.id);
    if (mode === 'all') return true;

    // Mention or reply-to-bot always passes.
    const mentioned = botUserId
      ? (message.mentions.users.has(botUserId) || message.mentions.repliedUser?.id === botUserId)
      : false;
    if (mentioned) return true;

    if (mode === 'mention') return false;

    // keyword mode: case-insensitive substring match on any keyword.
    const content = (message.content || '').toLowerCase();
    if (!content) return false;
    return this.keywords.some(k => content.includes(k));
  }
}
