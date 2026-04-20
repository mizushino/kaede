import {
  Client,
  GatewayIntentBits,
  Message,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
} from 'discord.js';
import path from 'path';
import { Bot } from '../core/bot.js';
import { Messenger } from '../core/messenger.js';
import { DiscordMessenger } from './messenger.js';
import { PromptLoader } from '../core/prompts.js';
import { logger } from '../core/logger.js';

export class DiscordBot extends Bot {
  readonly discord: Client;
  private promptLoader: PromptLoader;

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

    // Initialize prompt loader
    const promptsDir = process.env.PROMPTS_DIR;
    this.promptLoader = new PromptLoader(promptsDir);

    this.setupEventHandlers();
  }

  protected createMessenger(channelId: string): Messenger {
    return new DiscordMessenger(this.discord, channelId);
  }

  protected getBotId(): string {
    return this.discord.user?.id ?? '';
  }

  private async registerSlashCommands(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token || !this.discord.user) return;

    // Load prompt files
    await this.promptLoader.loadPrompts();
    const prompts = this.promptLoader.getAllPrompts();

    const commands = [
      new SlashCommandBuilder()
        .setName('clear')
        .setDescription('Clear the current AI session'),
      new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Show request usage statistics'),
      new SlashCommandBuilder()
        .setName('restart')
        .setDescription('Restart the bot process'),
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
              opt.setName('model_id').setDescription('Model ID').setRequired(true).setAutocomplete(true))
            .addStringOption(opt =>
              opt.setName('effort')
                .setDescription('Reasoning effort level')
                .addChoices(
                  { name: 'low', value: 'low' },
                  { name: 'medium', value: 'medium' },
                  { name: 'high', value: 'high' },
                  { name: 'xhigh', value: 'xhigh' },
                ))),
      new SlashCommandBuilder()
        .setName('schedule')
        .setDescription('Manage scheduled tasks')
        .addSubcommand(sub =>
          sub.setName('add')
            .setDescription('Add a scheduled task')
            .addStringOption(opt =>
              opt.setName('cron').setDescription('Cron expression (e.g. "0 9 * * *")').setRequired(true))
            .addChannelOption(opt =>
              opt.setName('channel').setDescription('Target channel').setRequired(true))
            .addStringOption(opt =>
              opt.setName('prompt').setDescription('Message to send when triggered').setRequired(true))
            .addStringOption(opt =>
              opt.setName('description').setDescription('Description of this schedule').setRequired(false)))
        .addSubcommand(sub =>
          sub.setName('list').setDescription('List all scheduled tasks'))
        .addSubcommand(sub =>
          sub.setName('remove')
            .setDescription('Remove a scheduled task')
            .addStringOption(opt =>
              opt.setName('id').setDescription('Schedule ID').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub =>
          sub.setName('toggle')
            .setDescription('Enable/disable a scheduled task')
            .addStringOption(opt =>
              opt.setName('id').setDescription('Schedule ID').setRequired(true).setAutocomplete(true))),
      new SlashCommandBuilder()
        .setName('function')
        .setDescription('Manage custom functions')
        .addSubcommand(sub =>
          sub.setName('list').setDescription('List all installed functions'))
        .addSubcommand(sub =>
          sub.setName('info')
            .setDescription('Show function source code')
            .addStringOption(opt =>
              opt.setName('name').setDescription('Function filename (e.g. weather.ts)').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub =>
          sub.setName('delete')
            .setDescription('Delete a function')
            .addStringOption(opt =>
              opt.setName('name').setDescription('Function filename (e.g. weather.ts)').setRequired(true).setAutocomplete(true))),
    ];

    // Add prompt file commands
    for (const prompt of prompts) {
      const builder = new SlashCommandBuilder()
        .setName(prompt.name)
        .setDescription(prompt.description || `Run ${prompt.name} prompt`);
      
      // Always add optional args parameter
      builder.addStringOption(opt =>
        opt.setName('args')
          .setDescription(prompt.argumentHint || 'Additional context or arguments')
          .setRequired(false)
      );

      commands.push(builder);
      logger.log(`[BOT] Registered prompt command: /${prompt.name}`);
    }

    const rest = new REST().setToken(token);
    try {
      const commandsJSON = commands.map(cmd => cmd.toJSON());
      logger.log(`[BOT] Registering ${commands.length} slash commands (${prompts.length} prompts)...`);
      await rest.put(Routes.applicationCommands(this.discord.user.id), { body: commandsJSON });
      logger.log(`[BOT] Successfully registered ${commands.length} slash commands`);
    } catch (err) {
      logger.error('[BOT] Failed to register slash commands:');
      logger.error(err);
    }
  }

  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused().toLowerCase();

    if (interaction.commandName === 'function') {
      const funcs = await this.listFunctionFiles();
      const choices = funcs
        .map(f => ({ name: f.name ? `${f.file} (${f.name})` : f.file, value: f.file }))
        .filter(c => c.name.toLowerCase().includes(focused) || c.value.toLowerCase().includes(focused))
        .slice(0, 25);
      await interaction.respond(choices);
    } else if (interaction.commandName === 'model') {
      try {
        const client = await this.clientManager.getClient();
        const models = await client.listModels();
        const choices = models
          .map(m => ({
            name: m.billing?.multiplier != null ? `${m.id} (${m.billing.multiplier}x)` : m.id,
            value: m.id,
          }))
          .filter(c => c.name.toLowerCase().includes(focused) || c.value.toLowerCase().includes(focused))
          .slice(0, 25);
        await interaction.respond(choices);
      } catch {
        await interaction.respond([]);
      }
    } else if (interaction.commandName === 'schedule') {
      const { readFile } = await import('fs/promises');
      try {
        const data = JSON.parse(await readFile(path.join(this.workspaceDir, 'schedules.json'), 'utf-8')) as { id: string; description?: string; cron?: string; enabled?: boolean }[];
        const choices = data
          .map(s => {
            const label = s.description ? `${s.id} — ${s.description}` : s.id;
            return { name: label.slice(0, 100), value: s.id };
          })
          .filter(c => c.name.toLowerCase().includes(focused) || c.value.toLowerCase().includes(focused))
          .slice(0, 25);
        await interaction.respond(choices);
      } catch {
        await interaction.respond([]);
      }
    }
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName === 'clear') {
      await this.clearAgent(interaction.channelId, interaction.guildId ?? undefined);
      await interaction.reply('🔄 Session cleared');
      return;
    }

    if (interaction.commandName === 'stats') {
      // Daily stats (last 7 days)
      const daily = this.counter.getDailyStats(7);
      const maxDaily = Math.max(...daily.map(d => d.requests), 1);
      const dailyLines = daily.length > 0
        ? daily.map(d => {
            const bar = '█'.repeat(Math.ceil(d.requests / maxDaily * 12));
            const label = d.date.slice(5); // MM-DD
            const modelDetail = Object.entries(d.models)
              .map(([m, c]) => `${m}(${c})`)
              .join(' ');
            return `  \`${label}\` ${bar} ${d.requests} req (↓${d.recv} ↑${d.sent}) [${modelDetail}]`;
          }).join('\n')
        : '  (No data)';

      // 30-day totals
      const all = this.counter.getDailyStats(30);
      const totalReq = all.reduce((s, d) => s + d.requests, 0);
      const totalRecv = all.reduce((s, d) => s + d.recv, 0);
      const totalSent = all.reduce((s, d) => s + d.sent, 0);
      const modelTotals: Record<string, number> = {};
      for (const d of all) {
        for (const [m, c] of Object.entries(d.models)) {
          modelTotals[m] = (modelTotals[m] || 0) + c;
        }
      }
      const modelSummary = Object.entries(modelTotals)
        .map(([m, c]) => `${m}(${c})`)
        .join(' ') || 'none';

      await interaction.reply({
        content:
          `📊 **Request Statistics**\n\n` +
          `📆 **Last 7 Days** (↓recv ↑sent)\n${dailyLines}\n\n` +
          `📋 **30-Day Total:** ${totalReq} req (↓${totalRecv} ↑${totalSent}) [${modelSummary}]`,
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'restart') {
      this.counter.flush();
      await interaction.reply('🔄 Restarting...');
      logger.log('[BOT] Restart requested via slash command');
      setTimeout(() => process.exit(0), 1000);
      return;
    }

    if (interaction.commandName === 'model') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'list') {
        await interaction.deferReply({ ephemeral: true });
        try {
          const client = await this.clientManager.getClient();
          const models = await client.listModels();
          const rows = models.map(m => ({
            id: m.id,
            cost: m.billing?.multiplier != null ? `${m.billing.multiplier}x` : '?',
            reasoning: m.supportedReasoningEfforts?.join('/') ?? '-',
          }));
          const idWidth = Math.max(5, ...rows.map(r => r.id.length));
          const costWidth = Math.max(4, ...rows.map(r => r.cost.length));
          const header = `${'MODEL'.padEnd(idWidth)}  ${'COST'.padEnd(costWidth)}  REASONING`;
          const divider = `${'─'.repeat(idWidth)}  ${'─'.repeat(costWidth)}  ${'─'.repeat(13)}`;
          const lines = rows.map(r => `${r.id.padEnd(idWidth)}  ${r.cost.padEnd(costWidth)}  ${r.reasoning}`);
          await interaction.editReply(`**Available models (${models.length}):**\n\`\`\`\n${header}\n${divider}\n${lines.join('\n')}\n\`\`\``);
        } catch (err) {
          await interaction.editReply(`❌ Failed to list models: ${(err as Error).message}`);
        }
      } else if (sub === 'get') {
        const agent = this.getOrCreateAgent(interaction.channelId, interaction.guildId ?? undefined);
        const current = agent.reasoningEffort ? ` (reasoning: ${agent.reasoningEffort})` : '';
        await interaction.reply({ content: `Current model: \`${agent.model}\`${current}`, ephemeral: true });
      } else if (sub === 'set') {
        const modelId = interaction.options.getString('model_id', true);
        const effort = (interaction.options.getString('effort') ?? '') as 'low' | 'medium' | 'high' | 'xhigh' | '';
        const agent = this.getOrCreateAgent(interaction.channelId, interaction.guildId ?? undefined);
        await agent.setModel(modelId, effort);
        const effortNote = effort ? ` / reasoning: \`${effort}\`` : '';
        await interaction.reply(`✅ Switched model to \`${modelId}\`${effortNote}`);
      }
      return;
    }

    if (interaction.commandName === 'schedule') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'add') {
        const cronExpr = interaction.options.getString('cron', true);
        const channel = interaction.options.getChannel('channel', true);
        const promptText = interaction.options.getString('prompt', true);
        const description = interaction.options.getString('description') || undefined;

        try {
          const entry = this.scheduler.add({
            cron: cronExpr,
            channelId: channel.id,
            guildId: interaction.guildId ?? undefined,
            prompt: promptText,
            description,
          });
          await interaction.reply({ content: `✅ Schedule added: \`${entry.id}\`\nCron: \`${entry.cron}\` → <#${entry.channelId}>\nPrompt: ${entry.prompt.slice(0, 100)}`, ephemeral: true });
        } catch (err) {
          await interaction.reply({ content: `❌ ${(err as Error).message}`, ephemeral: true });
        }
      } else if (sub === 'list') {
        const entries = this.scheduler.list();
        if (entries.length === 0) {
          await interaction.reply({ content: '📋 No scheduled tasks', ephemeral: true });
        } else {
          const lines = entries.map(e =>
            `${e.enabled ? '✅' : '⏸️'} \`${e.id}\` — \`${e.cron}\` → <#${e.channelId}>\n　${e.description || e.prompt.slice(0, 60)}`
          );
          await interaction.reply({ content: `📋 **Scheduled Tasks (${entries.length})**\n\n${lines.join('\n')}`, ephemeral: true });
        }
      } else if (sub === 'remove') {
        const id = interaction.options.getString('id', true);
        const removed = this.scheduler.remove(id);
        await interaction.reply({ content: removed ? `✅ Removed schedule \`${id}\`` : `❌ Schedule \`${id}\` not found`, ephemeral: true });
      } else if (sub === 'toggle') {
        const id = interaction.options.getString('id', true);
        const entry = this.scheduler.toggle(id);
        if (entry) {
          await interaction.reply({ content: `${entry.enabled ? '✅ Enabled' : '⏸️ Disabled'} schedule \`${id}\``, ephemeral: true });
        } else {
          await interaction.reply({ content: `❌ Schedule \`${id}\` not found`, ephemeral: true });
        }
      }
      return;
    }

    if (interaction.commandName === 'function') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'list') {
        const files = await this.listFunctionFiles();
        if (files.length === 0) {
          await interaction.reply({ content: '📦 **Functions**\n\nNo functions installed.', ephemeral: true });
        } else {
          const lines = files.map(f =>
            `\`${f.file}\` — **${f.name || 'unnamed'}**\n　${f.description || '(no description)'}`
          );
          await interaction.reply({ content: `📦 **Functions (${files.length})**\n\n${lines.join('\n')}`, ephemeral: true });
        }
      } else if (sub === 'info') {
        const name = interaction.options.getString('name', true);
        const filename = await this.resolveFunctionFile(name);
        if (!filename) {
          await interaction.reply({ content: `❌ Function \`${name}\` not found`, ephemeral: true });
        } else {
          try {
            const { readFile } = await import('fs/promises');
            const content = await readFile(path.join(this.functionsDir, filename), 'utf-8');
            const truncated = content.length > 1800 ? content.slice(0, 1800) + '\n... (truncated)' : content;
            await interaction.reply({ content: `📄 **${filename}**\n\`\`\`ts\n${truncated}\n\`\`\``, ephemeral: true });
          } catch {
            await interaction.reply({ content: `❌ Function \`${name}\` not found`, ephemeral: true });
          }
        }
      } else if (sub === 'delete') {
        const name = interaction.options.getString('name', true);
        const filename = await this.resolveFunctionFile(name);
        if (!filename) {
          await interaction.reply({ content: `❌ Function \`${name}\` not found`, ephemeral: true });
        } else {
          try {
            const { unlink } = await import('fs/promises');
            await unlink(path.join(this.functionsDir, filename));
            await interaction.reply({ content: `✅ Deleted function \`${filename}\``, ephemeral: true });
          } catch {
            await interaction.reply({ content: `❌ Failed to delete \`${filename}\``, ephemeral: true });
          }
        }
      }
      return;
    }

    // Check if this is a prompt command
    const prompt = this.promptLoader.getPrompt(interaction.commandName);
    if (prompt) {
      await interaction.deferReply();
      
      // Get optional arguments
      const args = interaction.options.getString('args') || '';
      
      // Construct the full prompt
      let fullPrompt = prompt.content;
      if (args) {
        fullPrompt = `${fullPrompt}\n\nAdditional context: ${args}`;
      }

      // Send to agent
      const agent = this.getOrCreateAgent(interaction.channelId, interaction.guildId ?? undefined);
      const incoming = {
        id: interaction.id,
        channelId: interaction.channelId,
        author: interaction.user.username,
        content: fullPrompt,
      };

      // Fire-and-forget: agent responds via send_message tool.
      // Do NOT await processMessage — it blocks until the session ends (30+ min).
      agent.processMessage(incoming, [], []).catch(err => {
        logger.error(`[BOT] Prompt execution error (${prompt.name}):`, err);
      });
      await interaction.editReply(`✅ プロンプト \`${prompt.name}\` を実行しました`);
      return;
    }
  }

  private setupEventHandlers(): void {
    this.discord.once('clientReady', async () => {
      logger.log(`[BOT] Ready as ${this.discord.user?.tag}`);
      this.discord.user?.setPresence({ status: 'idle', activities: [] });
      await this.registerSlashCommands();
    });

    this.discord.on('interactionCreate', async (interaction) => {
      if (interaction.isAutocomplete()) {
        await this.handleAutocomplete(interaction);
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      await this.handleSlashCommand(interaction as ChatInputCommandInteraction);
    });

    this.discord.on('messageCreate', async (message: Message) => {
      if (message.author.id === this.discord.user?.id) return;
      if (!message.content && message.attachments.size === 0) return;
      if (this.isDuplicate(message.id)) return;

      logger.log(`[BOT] Message from ${message.author.username}: ${message.content || '[Attachments]'}`);

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
          logger.log(`[BOT] Downloaded: ${fileName}`);
        } catch (err) {
          logger.error(`[BOT] Failed to download attachment:`, err);
        }
      }

      const agent = this.getOrCreateAgent(message.channel.id, message.guildId ?? undefined);
      const incoming = {
        id: message.id,
        channelId: message.channel.id,
        author: message.author.username,
        content: message.content,
      };
      await agent.processMessage(incoming, imageAttachments, fileAttachments);
    });
  }

  private async listFunctionFiles(): Promise<{ file: string; name?: string; description?: string }[]> {
    const { readdir, readFile } = await import('fs/promises');
    try {
      const entries = await readdir(this.functionsDir);
      const files = entries.filter(f => /\.(ts|js|mjs)$/.test(f));
      const result: { file: string; name?: string; description?: string }[] = [];
      for (const file of files) {
        const meta: typeof result[number] = { file };
        try {
          const src = await readFile(path.join(this.functionsDir, file), 'utf-8');
          meta.name = src.match(/export\s+const\s+name\s*=\s*['"`]([^'"`]+)['"`]/)?.[1];
          meta.description = src.match(/export\s+const\s+description\s*=\s*['"`]([^'"`]+)['"`]/)?.[1];
        } catch { /* skip */ }
        result.push(meta);
      }
      return result;
    } catch {
      return [];
    }
  }

  /** Resolve a function name (with or without extension) to an actual filename */
  private async resolveFunctionFile(name: string): Promise<string | null> {
    const safe = path.basename(name);
    const { readdir } = await import('fs/promises');
    try {
      const entries = await readdir(this.functionsDir);
      const files = entries.filter(f => /\.(ts|js|mjs)$/.test(f));
      // Exact match first
      if (files.includes(safe)) return safe;
      // Try appending extensions
      for (const ext of ['.ts', '.js', '.mjs']) {
        if (files.includes(safe + ext)) return safe + ext;
      }
      return null;
    } catch {
      return null;
    }
  }

  async start(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      logger.error('[BOT] No token found in environment');
      process.exit(1);
    }

    try {
      await this.clientManager.warmup();
      await this.discord.login(token);
      this.scheduler.restore();
      logger.log('[BOT] Connected to Discord');
    } catch (error) {
      logger.error('[BOT] Failed to connect:', error);
      process.exit(1);
    }
  }

  async shutdown(): Promise<void> {
    await super.shutdown();
    this.discord.destroy();
  }
}
