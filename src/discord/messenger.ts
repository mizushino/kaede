import { Client, ActivityType, TextChannel, ThreadChannel, AttachmentBuilder, Message } from 'discord.js';
import fs from 'fs/promises';
import path from 'path';
import { Messenger } from '../core/messenger.js';
import type { MessageInfo, ChannelInfo } from '../core/messenger.js';
import { logger } from '../core/logger.js';

export class DiscordMessenger extends Messenger {
  private client: Client;

  constructor(client: Client, channelId: string) {
    super(channelId);
    this.client = client;
  }

  async sendMessage(channelId: string, content?: string, replyTo?: string, imagePath?: string): Promise<number> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !(channel instanceof TextChannel || channel instanceof ThreadChannel)) {
      throw new Error('Channel not found or not a text channel');
    }

    const files: AttachmentBuilder[] = [];
    if (imagePath) {
      const fileData = await fs.readFile(imagePath);
      files.push(new AttachmentBuilder(fileData, { name: path.basename(imagePath) }));
    }

    const chunks = content ? this.splitMessage(content) : [''];

    for (let i = 0; i < chunks.length; i++) {
      const options: Record<string, unknown> = {};
      if (chunks[i]) options.content = chunks[i];
      if (i === 0 && replyTo) {
        options.reply = { messageReference: replyTo, failIfNotExists: false };
      }
      if (i === chunks.length - 1 && files.length > 0) {
        options.files = files;
      }
      await channel.send(options);
    }

    return chunks.length;
  }

  async getMessages(channelId: string, limit: number): Promise<MessageInfo[]> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !(channel instanceof TextChannel || channel instanceof ThreadChannel)) {
      throw new Error('Channel not found or not a text channel');
    }

    const messages = await channel.messages.fetch({ limit });
    return Array.from(messages.values()).map(msg => ({
      id: msg.id,
      author: msg.author.username,
      content: msg.content,
      timestamp: msg.createdAt.toISOString(),
    }));
  }

  async getChannels(serverId: string): Promise<ChannelInfo[]> {
    const guild = await this.client.guilds.fetch(serverId);
    const channels = await guild.channels.fetch();
    return Array.from(channels.values())
      .filter(ch => ch !== null)
      .map(ch => ({
        id: ch!.id,
        name: ch!.name,
        type: ch!.type,
      }));
  }

  protected async sendTypingIndicator(): Promise<void> {
    const channel = await this.client.channels.fetch(this.channelId);
    if (channel instanceof TextChannel || channel instanceof ThreadChannel) {
      await channel.sendTyping();
    }
  }

  protected applyStatus(text: string): void {
    if (!this.client.user) return;
    this.client.user.setPresence({
      status: 'online',
      activities: text ? [{ name: text, type: ActivityType.Custom }] : [],
    });
  }

  protected applyIdle(): void {
    if (!this.client.user) return;
    logger.log('[Discord] Presence: idle');
    this.client.user.setPresence({ status: 'idle', activities: [] });
  }

  async sendError(message: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(this.channelId);
      if (channel instanceof TextChannel || channel instanceof ThreadChannel) {
        await channel.send(`⚠️ Error: ${message.slice(0, 200)}`);
      }
    } catch { /* ignore */ }
  }

  async requestApproval(prompt: string, timeoutMs: number): Promise<boolean> {
    const channel = await this.client.channels.fetch(this.channelId);
    if (!channel || !(channel instanceof TextChannel || channel instanceof ThreadChannel)) {
      throw new Error('Channel not found');
    }

    const msg = await channel.send(prompt);
    await msg.react('✅');
    await msg.react('❌');

    const botId = this.client.user?.id;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const collector = msg.createReactionCollector({
        filter: (reaction, user) => {
          if (user.id === botId) return false;
          return reaction.emoji.name === '✅' || reaction.emoji.name === '❌';
        },
        max: 1,
        time: timeoutMs,
      });

      const finalize = (approved: boolean, suffix: string) => {
        if (settled) return;
        settled = true;
        collector.stop('settled');
        void msg.reactions.removeAll().catch(() => {});
        void msg.edit(prompt + suffix).catch(() => {});
        resolve(approved);
      };

      collector.on('collect', (reaction) => {
        const approved = reaction.emoji.name === '✅';
        finalize(approved, approved ? '\n**→ ✅ 許可されました**' : '\n**→ ❌ 拒否されました**');
      });

      collector.on('end', (collected) => {
        if (settled) return;
        if (collected.size === 0) {
          finalize(false, '\n**→ ⏰ タイムアウト（拒否扱い）**');
        }
      });
    });
  }

  async requestUserInput(question: string, choices?: string[], allowFreeform?: boolean): Promise<{ answer: string; wasFreeform: boolean }> {
    const channel = await this.client.channels.fetch(this.channelId);
    if (!channel || !(channel instanceof TextChannel || channel instanceof ThreadChannel)) {
      throw new Error('Channel not found');
    }

    const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    const hasChoices = choices && choices.length > 0;
    const canFreeform = allowFreeform !== false; // default true
    const normalizeEmoji = (value: string): string => value.replace(/\uFE0F|\u20E3/g, '');
    const getChoiceIndexFromReaction = (reaction: { emoji: { name?: string | null; toString(): string } }): number => {
      const candidates = [reaction.emoji.name ?? '', reaction.emoji.toString?.() ?? '']
        .map(normalizeEmoji)
        .filter(Boolean);

      for (const candidate of candidates) {
        if (candidate === '🔟') return 9;
        if (/^[1-9]$/.test(candidate)) return Number(candidate) - 1;
      }

      return -1;
    };
    const getChoiceIndexFromMessage = (value: string): number => {
      const normalized = value.trim().replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
      if (normalized === '10') return 9;
      if (/^[1-9]$/.test(normalized)) return Number(normalized) - 1;
      return -1;
    };

    // Build prompt message
    let prompt = `❓ **質問**\n${question}`;
    if (hasChoices) {
      prompt += '\n\n' + choices.map((c, i) => `${NUMBER_EMOJIS[i] ?? `${i + 1}.`} ${c}`).join('\n');
      if (canFreeform) {
        prompt += '\n\n💬 リアクションで選択、またはメッセージで自由回答';
      }
    }

    const msg = await channel.send(prompt);
    const botId = this.client.user?.id;
    const timeoutMs = Number(process.env.USER_RESPONSE_TIMEOUT_MS) || 300_000;

    return new Promise<{ answer: string; wasFreeform: boolean }>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const reactionCollector = hasChoices
        ? msg.createReactionCollector({
            filter: (reaction, user) => {
              if (user.id === botId) return false;
              const idx = getChoiceIndexFromReaction(reaction);
              return idx >= 0 && idx < choices.length;
            },
            max: 1,
            time: timeoutMs,
          })
        : null;
      const messageCollector = canFreeform
        ? channel.createMessageCollector({
            filter: (m: Message) => m.author.id !== botId,
            max: 1,
            time: timeoutMs,
          })
        : null;

      const finalize = (result: { answer: string; wasFreeform: boolean }, displaySuffix: string) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        try {
          reactionCollector?.stop('settled');
          messageCollector?.stop('settled');
          void msg.reactions.removeAll().catch(() => {});
          void msg.edit(prompt + displaySuffix).catch(() => {});
        } catch (err) {
          // Resolve regardless so callers don't hang on cleanup failures.
          void err;
        }
        resolve(result);
      };

      timer = setTimeout(() => {
        finalize({ answer: '', wasFreeform: true }, '\n\n**→ ⏰ タイムアウト**');
      }, timeoutMs);

      reactionCollector?.on('collect', (reaction) => {
        const idx = getChoiceIndexFromReaction(reaction);
        const answer = idx >= 0 && idx < choices!.length ? choices![idx] : '';
        finalize({ answer, wasFreeform: false }, `\n\n**→ ${answer}**`);
      });

      messageCollector?.on('collect', (collected) => {
        const rawAnswer = collected.content ?? '';
        const choiceIndex = hasChoices ? getChoiceIndexFromMessage(rawAnswer) : -1;
        const answer = choiceIndex >= 0 && choices && choiceIndex < choices.length ? choices[choiceIndex] : rawAnswer;
        finalize({ answer, wasFreeform: choiceIndex < 0 }, `\n\n**→ 💬 ${answer.slice(0, 100)}**`);
      });

      // Add reaction emojis after collectors are active.
      if (hasChoices) {
        void (async () => {
          for (let i = 0; i < Math.min(choices.length, NUMBER_EMOJIS.length); i++) {
            if (settled) break;
            await msg.react(NUMBER_EMOJIS[i]).catch(() => {});
          }
        })();
      }
    });
  }
}
