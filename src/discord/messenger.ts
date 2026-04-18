import { Client, ActivityType, TextChannel, ThreadChannel, AttachmentBuilder, Message } from 'discord.js';
import fs from 'fs/promises';
import path from 'path';
import { Messenger } from '../core/messenger.js';
import type { MessageInfo, ChannelInfo, ServerInfo } from '../core/messenger.js';
import { logger } from '../core/logger.js';

export class DiscordMessenger extends Messenger {
  readonly channelId: string;
  private client: Client;

  constructor(client: Client, channelId: string) {
    super();
    this.client = client;
    this.channelId = channelId;
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

  getServers(): ServerInfo[] {
    return this.client.guilds.cache.map(guild => ({
      id: guild.id,
      name: guild.name,
      memberCount: guild.memberCount,
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

    try {
      const collected = await msg.awaitReactions({
        filter: (reaction, user) => {
          if (user.id === botId) return false;
          return reaction.emoji.name === '✅' || reaction.emoji.name === '❌';
        },
        max: 1,
        time: timeoutMs,
        errors: ['time'],
      });

      const reaction = collected.first();
      const approved = reaction?.emoji.name === '✅';

      // Remove reactions and show result
      await msg.reactions.removeAll().catch(() => {});
      const suffix = approved ? '\n**→ ✅ 許可されました**' : '\n**→ ❌ 拒否されました**';
      await msg.edit(prompt + suffix).catch(() => {});

      return approved;
    } catch {
      // Timeout — remove reactions and show result
      await msg.reactions.removeAll().catch(() => {});
      await msg.edit(prompt + '\n**→ ⏰ タイムアウト（拒否扱い）**').catch(() => {});
      return false;
    }
  }

  async requestUserInput(question: string, choices?: string[], allowFreeform?: boolean): Promise<{ answer: string; wasFreeform: boolean }> {
    const channel = await this.client.channels.fetch(this.channelId);
    if (!channel || !(channel instanceof TextChannel || channel instanceof ThreadChannel)) {
      throw new Error('Channel not found');
    }

    const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    const hasChoices = choices && choices.length > 0;
    const canFreeform = allowFreeform !== false; // default true

    // Build prompt message
    let prompt = `❓ **質問**\n${question}`;
    if (hasChoices) {
      prompt += '\n\n' + choices.map((c, i) => `${NUMBER_EMOJIS[i] ?? `${i + 1}.`} ${c}`).join('\n');
      if (canFreeform) {
        prompt += '\n\n💬 リアクションで選択、またはメッセージで自由回答';
      }
    }

    const msg = await channel.send(prompt);

    // Add reaction emojis for choices
    if (hasChoices) {
      for (let i = 0; i < Math.min(choices.length, NUMBER_EMOJIS.length); i++) {
        await msg.react(NUMBER_EMOJIS[i]);
      }
    }

    const botId = this.client.user?.id;
    const timeoutMs = Number(process.env.USER_RESPONSE_TIMEOUT_MS) || 300_000;

    // Wait for reaction (choice) or message (freeform) concurrently
    return new Promise<{ answer: string; wasFreeform: boolean }>((resolve) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
      };

      const timer = setTimeout(async () => {
        if (settled) return;
        cleanup();
        await msg.reactions.removeAll().catch(() => {});
        await msg.edit(prompt + '\n\n**→ ⏰ タイムアウト**').catch(() => {});
        resolve({ answer: '', wasFreeform: true });
      }, timeoutMs);

      // Listen for reactions (choices)
      if (hasChoices) {
        const reactionFilter = (reaction: any, user: any) => {
          if (user.id === botId) return false;
          return NUMBER_EMOJIS.slice(0, choices.length).includes(reaction.emoji.name);
        };
        msg.awaitReactions({ filter: reactionFilter, max: 1, time: timeoutMs, errors: ['time'] })
          .then(async (collected) => {
            if (settled) return;
            cleanup();
            const reaction = collected.first();
            const idx = NUMBER_EMOJIS.indexOf(reaction?.emoji.name ?? '');
            const answer = idx >= 0 && idx < choices.length ? choices[idx] : '';
            await msg.reactions.removeAll().catch(() => {});
            await msg.edit(prompt + `\n\n**→ ${answer}**`).catch(() => {});
            resolve({ answer, wasFreeform: false });
          })
          .catch(() => {}); // timeout handled above
      }

      // Listen for freeform text message
      if (canFreeform) {
        const messageFilter = (m: Message) => m.author.id !== botId;
        channel.awaitMessages({ filter: messageFilter, max: 1, time: timeoutMs, errors: ['time'] })
          .then(async (collected) => {
            if (settled) return;
            cleanup();
            const answer = collected.first()?.content ?? '';
            await msg.reactions.removeAll().catch(() => {});
            await msg.edit(prompt + `\n\n**→ 💬 ${answer.slice(0, 100)}**`).catch(() => {});
            resolve({ answer, wasFreeform: true });
          })
          .catch(() => {}); // timeout handled above
      }
    });
  }
}
