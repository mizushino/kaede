import {
  Client,
  GatewayIntentBits,
  Message,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from 'discord.js';
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

  private async registerSlashCommands(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token || !this.discord.user) return;

    const commands = [
      new SlashCommandBuilder()
        .setName('reset')
        .setDescription('Reset the current AI session'),
      new SlashCommandBuilder()
        .setName('model')
        .setDescription('View or switch the AI model')
        .addSubcommand(sub =>
          sub.setName('get').setDescription('Show current model'))
        .addSubcommand(sub =>
          sub.setName('list').setDescription('List available models'))
        .addSubcommand(sub =>
          sub.setName('set')
            .setDescription('Switch to a different model')
            .addStringOption(opt =>
              opt.setName('model_id').setDescription('Model ID').setRequired(true))
            .addStringOption(opt =>
              opt.setName('effort')
                .setDescription('Reasoning effort level')
                .addChoices(
                  { name: 'low', value: 'low' },
                  { name: 'medium', value: 'medium' },
                  { name: 'high', value: 'high' },
                  { name: 'xhigh', value: 'xhigh' },
                ))),
    ].map(cmd => cmd.toJSON());

    const rest = new REST().setToken(token);
    try {
      await rest.put(Routes.applicationCommands(this.discord.user.id), { body: commands });
      console.log('[BOT] Slash commands registered');
    } catch (err) {
      console.error('[BOT] Failed to register slash commands:', err);
    }
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName === 'reset') {
      await this.resetAgent(interaction.channelId);
      await interaction.reply('🔄 Session reset');
      return;
    }

    if (interaction.commandName === 'model') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'list') {
        await interaction.deferReply();
        try {
          const client = await this.clientManager.getClient();
          const models = await client.listModels();
          const lines = models.map(m => {
            const multiplier = m.billing?.multiplier != null ? `${m.billing.multiplier}x` : '?';
            const reasoning = m.supportedReasoningEfforts?.join('/') ?? '-';
            return `\`${m.id}\` — cost: ${multiplier} / reasoning: ${reasoning}`;
          });
          await interaction.editReply(`**Available models (${models.length}):**\n${lines.join('\n')}`);
        } catch (err) {
          await interaction.editReply(`❌ Failed to list models: ${(err as Error).message}`);
        }
      } else if (sub === 'get') {
        const agent = this.getOrCreateAgent(interaction.channelId);
        const current = agent.reasoningEffort ? ` (reasoning: ${agent.reasoningEffort})` : '';
        await interaction.reply(`Current model: \`${agent.model}\`${current}`);
      } else if (sub === 'set') {
        const modelId = interaction.options.getString('model_id', true);
        const effort = (interaction.options.getString('effort') ?? '') as 'low' | 'medium' | 'high' | 'xhigh' | '';
        const agent = this.getOrCreateAgent(interaction.channelId);
        await agent.setModel(modelId, effort);
        const effortNote = effort ? ` / reasoning: \`${effort}\`` : '';
        await interaction.reply(`✅ Switched model to \`${modelId}\`${effortNote}`);
      }
    }
  }

  private setupEventHandlers(): void {
    this.discord.once('clientReady', async () => {
      console.log(`[BOT] Ready as ${this.discord.user?.tag}`);
      this.discord.user?.setPresence({ status: 'idle', activities: [] });
      await this.registerSlashCommands();
    });

    this.discord.on('interactionCreate', async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      await this.handleSlashCommand(interaction as ChatInputCommandInteraction);
    });

    this.discord.on('messageCreate', async (message: Message) => {
      if (message.author.id === this.discord.user?.id) return;
      if (!message.content && message.attachments.size === 0) return;
      if (this.isDuplicate(message.id)) return;

      console.log(`[BOT] Message from ${message.author.username}: ${message.content || '[Attachments]'}`);

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
