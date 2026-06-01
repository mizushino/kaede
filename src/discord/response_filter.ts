import fs from 'fs';
import path from 'path';
import type { Message } from 'discord.js';
import { logger } from '../core/logger.js';

export type ResponseMode = 'all' | 'mention' | 'keyword' | 'off';

const VALID_MODES: ResponseMode[] = ['all', 'mention', 'keyword', 'off'];

export function isResponseMode(value: string): value is ResponseMode {
  return (VALID_MODES as string[]).includes(value);
}

interface ChannelOverride {
  mode: ResponseMode;
  keywords?: string[];
}

type RawOverride = ResponseMode | ChannelOverride;

interface OverridesFile {
  [channelId: string]: ChannelOverride;
}

export class ResponseFilter {
  private readonly defaultMode: ResponseMode;
  private readonly keywords: string[];
  private readonly overridesPath: string;
  private readonly legacyOverridesPath: string;
  private overrides: OverridesFile = {};

  constructor(configDir: string) {
    const rawMode = (process.env.RESPONSE_MODE || 'all').toLowerCase();
    this.defaultMode = isResponseMode(rawMode) ? rawMode : 'all';

    const explicit = (process.env.RESPONSE_KEYWORDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    this.keywords = explicit.map(k => k.toLowerCase());

    this.overridesPath = path.join(configDir, 'watch.json');
    this.legacyOverridesPath = path.join(configDir, 'response.json');
    this.load();

    logger.log(`[FILTER] Default mode: ${this.defaultMode} | keywords: ${this.keywords.join(',') || '(none)'}`);
    if (this.keywords.length === 0 && this.usesKeywordMode()) {
      logger.error('[FILTER] WARNING: keyword mode is configured but no RESPONSE_KEYWORDS provided. Non-mention messages will be ignored.');
    }
  }

  private usesKeywordMode(): boolean {
    if (this.defaultMode === 'keyword') return true;
    return Object.values(this.overrides).some(override => override.mode === 'keyword');
  }

  private load(): void {
    try {
      const sourcePath = fs.existsSync(this.overridesPath)
        ? this.overridesPath
        : (fs.existsSync(this.legacyOverridesPath) ? this.legacyOverridesPath : null);
      if (sourcePath) {
        const raw = JSON.parse(fs.readFileSync(sourcePath, 'utf-8')) as Record<string, RawOverride>;
        const cleaned: OverridesFile = {};
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === 'string' && isResponseMode(v)) {
            cleaned[k] = { mode: v };
            continue;
          }
          if (v && typeof v === 'object' && isResponseMode(v.mode)) {
            const keywords = Array.isArray(v.keywords)
              ? v.keywords.map(s => String(s).trim().toLowerCase()).filter(Boolean)
              : undefined;
            cleaned[k] = { mode: v.mode, keywords };
          }
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
    return this.overrides[channelId]?.mode ?? this.defaultMode;
  }

  getDefaultMode(): ResponseMode {
    return this.defaultMode;
  }

  getOverride(channelId: string): ResponseMode | undefined {
    return this.overrides[channelId]?.mode;
  }

  getChannelKeywords(channelId: string): string[] | undefined {
    const keywords = this.overrides[channelId]?.keywords;
    return keywords ? [...keywords] : undefined;
  }

  getKeywords(): string[] {
    return [...this.keywords];
  }

  getEffectiveKeywords(channelId: string): string[] {
    const channelKeywords = this.overrides[channelId]?.keywords;
    if (channelKeywords && channelKeywords.length > 0) return [...channelKeywords];
    return this.getKeywords();
  }

  setOverride(channelId: string, mode: ResponseMode, keywords?: string[]): void {
    const cleanedKeywords = (keywords || [])
      .map(k => k.trim().toLowerCase())
      .filter(Boolean);
    this.overrides[channelId] = mode === 'keyword' && cleanedKeywords.length > 0
      ? { mode, keywords: cleanedKeywords }
      : { mode };
    this.save();
    if (mode === 'keyword' && this.getEffectiveKeywords(channelId).length === 0) {
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
    if (mode === 'off') return false;
    if (mode === 'all') return true;

    // Mention or reply-to-bot always passes.
    const mentioned = botUserId
      ? (message.mentions.users.has(botUserId) || message.mentions.repliedUser?.id === botUserId)
      : false;
    if (mentioned) return true;

    if (mode === 'mention') return false;

    // keyword mode: case-insensitive substring match against configured keywords.
    const content = (message.content || '').toLowerCase();
    if (!content) return false;
    return this.getEffectiveKeywords(message.channel.id).some(k => content.includes(k));
  }
}
