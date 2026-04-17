import { Client, GatewayIntentBits, Message } from 'discord.js';
import path from 'path';
import { Bot } from '../core/bot.js';
import { Messenger } from '../core/messenger.js';
import { DiscordMessenger } from './messenger.js';

export class DiscordBot extends Bot {
  readonly discord: Client;

  constructor() {
    super();
    this.discord = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    this.setupEventHandlers();
  }

  protected createMessenger(channelId: string): Messenger {
    return new DiscordMessenger(this.discord, channelId);
  }

  private setupEventHandlers(): void {
    this.discord.once('clientReady', () => {
      console.log(`[BOT] Ready as ${this.discord.user?.tag}`);
      this.discord.user?.setPresence({ status: 'idle', activities: [] });
    });

    this.discord.on('messageCreate', async (message: Message) => {
      if (message.author.id === this.discord.user?.id) return;
      if (!message.content && message.attachments.size === 0) return;
      if (this.isDuplicate(message.id)) return;

      console.log(`[BOT] Message from ${message.author.username}: ${message.content || '[Attachments]'}`);

      // Reset command — requires bot mention to avoid multiple bots all responding
      if (message.content.includes('!reset')
        && message.mentions.users.has(this.discord.user!.id)) {
        const agent = await this.resetAgent(message.channel.id);
        if (agent) {
          await message.reply(`🔄 Reset ${agent.model} session`);
        }
        return;
      }

      // Model switch command: !model <modelId> [reasoningEffort]
      // Requires bot mention to avoid multiple bots all responding
      if (message.content.includes('!model') && message.mentions.users.has(this.discord.user!.id)) {
        const parts = message.content.trim().split(/\s+/);
        const modelIdx = parts.indexOf('!model');
        const modelId = parts[modelIdx + 1];
        const effort = parts[modelIdx + 2] as 'low' | 'medium' | 'high' | 'xhigh' | undefined;

        if (modelId === 'list') {
          try {
            const client = await this.clientManager.getClient();
            const models = await client.listModels();
            const lines = models.map(m => {
              const multiplier = m.billing?.multiplier != null ? `${m.billing.multiplier}x` : '?';
              const reasoning = m.supportedReasoningEfforts?.join('/') ?? '-';
              return `\`${m.id}\` — cost: ${multiplier} / reasoning: ${reasoning}`;
            });
            await message.reply(`**Available models (${models.length}):**\n${lines.join('\n')}`);
          } catch (err) {
            await message.reply(`❌ Failed to list models: ${(err as Error).message}`);
          }
        } else if (!modelId) {
          const agent = this.getOrCreateAgent(message.channel.id);
          const current = agent.reasoningEffort ? ` (reasoning: ${agent.reasoningEffort})` : '';
          await message.reply(`Current model: \`${agent.model}\`${current}`);
        } else {
          const agent = this.getOrCreateAgent(message.channel.id);
          await agent.setModel(modelId, effort ?? '');
          const effortNote = effort ? ` / reasoning: \`${effort}\`` : '';
          await message.reply(`✅ Switched model to \`${modelId}\`${effortNote}`);
        }
        return;
      }

      // Download attachments
      const imageAttachments: string[] = [];
      const fileAttachments: string[] = [];
      for (const [, attachment] of message.attachments) {
        const fileName = `${Date.now()}_${attachment.name}`;
        const filePath = path.join(this.temporaryDir, fileName);
        try {
          await this.downloadAttachment(attachment.url, filePath);
          if (attachment.contentType?.startsWith('image/')) {
            imageAttachments.push(filePath);
          } else {
            fileAttachments.push(filePath);
          }
          console.log(`[BOT] Downloaded: ${fileName}`);
        } catch (err) {
          console.error(`[BOT] Failed to download attachment:`, err);
        }
      }

      const agent = this.getOrCreateAgent(message.channel.id);
      const incoming = {
        id: message.id,
        author: message.author.username,
        content: message.content,
      };
      await agent.processMessage(incoming, imageAttachments, fileAttachments);
    });
  }

  async start(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      console.error('[BOT] No token found in environment');
      process.exit(1);
    }

    try {
      await this.clientManager.warmup();
      await this.discord.login(token);
      console.log('[BOT] Connected to Discord');
    } catch (error) {
      console.error('[BOT] Failed to connect:', error);
      process.exit(1);
    }
  }

  async shutdown(): Promise<void> {
    await super.shutdown();
    this.discord.destroy();
  }
}
