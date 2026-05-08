import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  MessageFlags,
} from 'discord.js';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { logger } from '../core/logger.js';
import { IpcClient } from '../core/ipc.js';
import { PromptLoader } from '../core/prompts.js';
import { areFunctionManagementToolsEnabled, areScheduleManagementToolsEnabled } from '../core/tool_features.js';

const ENV_SWITCH_IGNORE_PREFIXES = ['example', 'defaults'];

export class AgentHubBot {
  readonly discord: Client;
  private readonly workspaceDir: string;
  private readonly ipcClient: IpcClient;
  private readonly promptLoader: PromptLoader;

  constructor() {
    this.workspaceDir = process.env.WORKSPACE_DIR || 'workspace';
    const configDir = path.resolve('.kaede', process.env.AGENT?.trim() || 'agenthub');
    fs.mkdirSync(configDir, { recursive: true });
    this.ipcClient = new IpcClient();
    this.promptLoader = new PromptLoader(process.env.PROMPTS_DIR);
    this.discord = new Client({
      intents: [
        GatewayIntentBits.Guilds,
      ],
    });
  }

  private filterTarget(name: string, focused: string): boolean {
    return name.toLowerCase().includes(focused) &&
      name !== 'agenthub' &&
      !ENV_SWITCH_IGNORE_PREFIXES.some(p => name.startsWith(p));
  }

  private async getRunningBotNames(): Promise<string[]> {
    const { readdir } = await import('fs/promises');
    const projectRoot = path.resolve(this.workspaceDir, '..');
    let envNames: Set<string>;
    try {
      const allFiles = await readdir(projectRoot);
      envNames = new Set(
        allFiles
          .filter(f => /^\.env\..+/.test(f))
          .map(f => f.replace(/^\.env\./, ''))
          .filter(n => this.filterTarget(n, '')),
      );
      if (fs.existsSync(path.join(projectRoot, '.env'))) envNames.add('default');
    } catch {
      envNames = new Set();
    }
    try {
      const output = execSync('pm2 jlist', { encoding: 'utf-8', stdio: 'pipe' });
      const processes = JSON.parse(output) as Array<{ name: string; pm2_env: { status: string } }>;
      const running = processes
        .filter(p => p.pm2_env?.status === 'online' && envNames.has(p.name))
        .map(p => p.name)
        .filter(name => this.filterTarget(name, ''));
      if (running.length > 0) return running;
    } catch {}
    return [...envNames].filter(t => this.filterTarget(t, ''));
  }

  private async getBotTargets(focused: string, includeAll = false): Promise<string[]> {
    const names = (await this.getRunningBotNames()).filter(n => this.filterTarget(n, focused));
    const results = names.slice(0, 24);
    if (includeAll && 'all'.includes(focused)) results.push('all');
    return results;
  }

  private async registerSlashCommands(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token || !this.discord.user) return;

    await this.promptLoader.loadPrompts();
    const prompts = this.promptLoader.getAllPrompts();

    const addTarget = (b: SlashCommandBuilder) => 
      b.addStringOption(opt => opt.setName('target').setDescription('The target bot (e.g. sumire)').setRequired(true).setAutocomplete(true));

    const commands = [
      addTarget(new SlashCommandBuilder().setName('clear').setDescription('Clear the AI session for a specific bot')),
      new SlashCommandBuilder()
        .setName('response')
        .setDescription('Manage per-channel response mode')
        .addSubcommand(sub =>
          sub.setName('status').setDescription('Show effective response mode for this channel').addStringOption(opt => opt.setName('target').setDescription('The target bot').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub =>
          sub.setName('set')
            .setDescription('Override the response mode for this channel')
            .addStringOption(opt => opt.setName('target').setDescription('The target bot').setRequired(true).setAutocomplete(true))
            .addStringOption(opt =>
              opt.setName('mode').setDescription('Response mode').setRequired(true)
                .addChoices({ name: 'all (respond to every message)', value: 'all' }, { name: 'mention (only @ or reply)', value: 'mention' }, { name: 'keyword (mention or keyword)', value: 'keyword' })))
        .addSubcommand(sub =>
          sub.setName('reset').setDescription('Remove channel override (use default)').addStringOption(opt => opt.setName('target').setDescription('The target bot').setRequired(true).setAutocomplete(true))),
      new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Show request usage statistics')
        .addStringOption(opt => opt.setName('target').setDescription('The target bot').setRequired(true).setAutocomplete(true))
        .addIntegerOption(opt => opt.setName('days').setDescription('Number of days to show (default: 7)').setRequired(false).setMinValue(1).setMaxValue(90)),
      addTarget(new SlashCommandBuilder().setName('context').setDescription('Show current context window usage')),
      new SlashCommandBuilder()
        .setName('restart')
        .setDescription('Restart a bot process')
        .addStringOption(opt => opt.setName('target').setDescription('The target bot (or "all")').setRequired(true).setAutocomplete(true)),
      new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop a bot process')
        .addStringOption(opt => opt.setName('target').setDescription('The target bot (or "all")').setRequired(true).setAutocomplete(true)),
      new SlashCommandBuilder()
        .setName('model')
        .setDescription('View or switch the AI model')
        .addSubcommand(sub => sub.setName('get').setDescription('Show current model').addStringOption(opt => opt.setName('target').setDescription('The target bot').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub => sub.setName('list').setDescription('List available models').addStringOption(opt => opt.setName('target').setDescription('The target bot').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub =>
          sub.setName('set')
            .setDescription('Switch to a different model')
            .addStringOption(opt => opt.setName('target').setDescription('The target bot').setRequired(true).setAutocomplete(true))
            .addStringOption(opt => opt.setName('model_id').setDescription('Model ID').setRequired(true))
            .addStringOption(opt =>
              opt.setName('effort').setDescription('Reasoning effort level').addChoices({ name: 'low', value: 'low' }, { name: 'medium', value: 'medium' }, { name: 'high', value: 'high' }, { name: 'xhigh', value: 'xhigh' }))),
      ...(areScheduleManagementToolsEnabled() ? [new SlashCommandBuilder()
        .setName('schedule')
        .setDescription('Manage scheduled tasks')
        .addSubcommand(sub =>
          sub.setName('add')
            .setDescription('Add a scheduled task')
            .addStringOption(opt => opt.setName('target').setDescription('The target bot').setRequired(true).setAutocomplete(true))
            .addStringOption(opt => opt.setName('cron').setDescription('Cron expression').setRequired(true))
            .addChannelOption(opt => opt.setName('channel').setDescription('Target channel').setRequired(true))
            .addStringOption(opt => opt.setName('prompt').setDescription('Message to send').setRequired(true))
            .addStringOption(opt => opt.setName('description').setDescription('Description').setRequired(false)))
        .addSubcommand(sub => sub.setName('list').setDescription('List all scheduled tasks').addStringOption(opt => opt.setName('target').setDescription('The target bot').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub => sub.setName('remove').setDescription('Remove a scheduled task').addStringOption(opt => opt.setName('target').setDescription('The target bot').setRequired(true).setAutocomplete(true))
          .addStringOption(opt => opt.setName('id').setDescription('Schedule ID').setRequired(true)))] : []),
      ...(areFunctionManagementToolsEnabled() ? [new SlashCommandBuilder()
        .setName('function')
        .setDescription('Manage custom functions')
        .addSubcommand(sub => sub.setName('list').setDescription('List all installed functions').addStringOption(opt => opt.setName('target').setDescription('The target bot').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub => sub.setName('info').setDescription('Show function source code').addStringOption(opt => opt.setName('target').setDescription('The target bot').setRequired(true).setAutocomplete(true)).addStringOption(opt => opt.setName('name').setDescription('Function filename').setRequired(true)))
        .addSubcommand(sub => sub.setName('delete').setDescription('Delete a function').addStringOption(opt => opt.setName('target').setDescription('The target bot').setRequired(true).setAutocomplete(true)).addStringOption(opt => opt.setName('name').setDescription('Function filename').setRequired(true)))] : []),
    ];

    for (const prompt of prompts) {
      const builder = new SlashCommandBuilder()
        .setName(prompt.name)
        .setDescription(prompt.description || `Run ${prompt.name} prompt`)
        .addStringOption(opt => opt.setName('target').setDescription('The target bot').setRequired(true).setAutocomplete(true))
        .addStringOption(opt => opt.setName('args').setDescription(prompt.argumentHint || 'Additional context').setRequired(false));
      commands.push(builder);
    }

    const rest = new REST().setToken(token);
    try {
      const commandsJSON = commands.map(cmd => cmd.toJSON());
      logger.log(`[AGENT HUB] Registering ${commands.length} slash commands...`);
      await rest.put(Routes.applicationCommands(this.discord.user.id), { body: commandsJSON });
      logger.log(`[AGENT HUB] Successfully registered commands.`);
    } catch (err) {
      logger.error('[AGENT HUB] Failed to register commands:', err);
    }
  }

  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused(true);
    if (focused.name === 'target') {
      const allSupportedCommands = ['restart', 'stop'];
      const sub = interaction.options.getSubcommand(false);
      const supportsAll = allSupportedCommands.includes(interaction.commandName) ||
        (interaction.commandName === 'response' && (sub === 'set' || sub === 'reset'));
      const targets = await this.getBotTargets(focused.value.toLowerCase(), supportsAll);
      await interaction.respond(targets.slice(0, 25).map(t => ({ name: t === 'all' ? 'ALL AGENTS' : t, value: t })));
    }
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const target = interaction.options.getString('target');
    if (!target) return; // Should not happen since target is required

    if (interaction.commandName === 'restart' || interaction.commandName === 'stop') {
      await interaction.deferReply();
      const pm2Command = interaction.commandName === 'restart' ? 'restart' : 'stop';
      const emoji = pm2Command === 'restart' ? '🔄' : '⏹️';

      if (target === 'all') {
        const bots = await this.getRunningBotNames();
        const results = bots.map(name => {
          try {
            execSync(`pm2 ${pm2Command} ${name}`, { stdio: 'pipe' });
            return { name, ok: true };
          } catch {
            return { name, ok: false };
          }
        });
        const ok = results.filter(r => r.ok).map(r => `\`${r.name}\``).join(', ');
        const ng = results.filter(r => !r.ok).map(r => `\`${r.name}\``).join(', ');
        const lines = [];
        if (ok) lines.push(`${emoji} ${pm2Command}: ${ok}`);
        if (ng) lines.push(`❌ Failed: ${ng}`);
        await interaction.editReply(lines.join('\n') || '（対象ボットなし）');
      } else {
        const pm2Target = target === 'default' ? 'kaede' : target;
        try {
          if (pm2Command === 'restart') {
            execSync(`nohup bash -c 'sleep 1 && pm2 restart ${pm2Target}' > /dev/null 2>&1 &`, { stdio: 'pipe' });
          } else {
            execSync(`pm2 stop ${pm2Target}`, { stdio: 'pipe' });
          }
          await interaction.editReply(`${emoji} ${pm2Command === 'restart' ? 'Restarting' : 'Stopped'} PM2 process \`${pm2Target}\`...`);
        } catch (err) {
          logger.error(`[AGENT HUB] Failed to ${pm2Command}:`, err);
          await interaction.editReply(`❌ Failed to ${pm2Command} \`${pm2Target}\`. Is it running under PM2?`);
        }
      }
      return;
    }

    // For all other commands, route via IPC
    const isEphemeral = ['response', 'stats', 'context', 'model', 'schedule', 'function'].includes(interaction.commandName);
    await interaction.deferReply({ flags: isEphemeral ? MessageFlags.Ephemeral : undefined });

    const args: Record<string, any> = {};
    interaction.options.data.forEach(opt => {
      if (opt.name !== 'target') {
        if (opt.options) {
          args.sub = opt.name;
          opt.options.forEach(subOpt => {
            args[subOpt.name] = subOpt.channel ? subOpt.channel.id : subOpt.value;
            if (subOpt.name === 'channel') args.channelIdTarget = subOpt.channel?.id;
          });
        } else {
          args[opt.name] = opt.channel ? opt.channel.id : opt.value;
        }
      }
    });

    let commandName = interaction.commandName;
    if (this.promptLoader.getPrompt(commandName)) {
      args.promptName = commandName;
      args.promptArgs = args.args;
      args.username = interaction.user.username;
      commandName = 'prompt';
    }

    const allTargetCommands = ['response'];
    if (target === 'all' && allTargetCommands.includes(interaction.commandName)) {
      const sub = args.sub as string | undefined;
      if (sub === 'set' || sub === 'reset') {
        const bots = await this.getRunningBotNames();
        const results = await Promise.allSettled(
          bots.map(name => this.ipcClient.sendRequest(name, commandName, interaction.channelId, interaction.guildId ?? undefined, args)),
        );
        const ok = results.filter((r, i) => r.status === 'fulfilled' && r.value.success).length;
        const ng = results.length - ok;
        const summary = `✅ ${ok}個成功${ng > 0 ? `、❌ ${ng}個失敗` : ''}`;
        await interaction.editReply({ content: summary });
        return;
      }
    }

    try {
      const resp = await this.ipcClient.sendRequest(target, commandName, interaction.channelId, interaction.guildId ?? undefined, args);
      if (resp.success) {
        await interaction.editReply({ content: resp.data ?? '✅ Success' });
      } else {
        await interaction.editReply({ content: `❌ Error from \`${target}\`: ${resp.error}` });
      }
    } catch (err) {
      await interaction.editReply({ content: `❌ Failed to communicate with \`${target}\`: ${(err as Error).message}` });
    }
  }

  async start(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      logger.error('[AGENT HUB] No token found in environment');
      process.exit(1);
    }

    this.discord.once('clientReady', async () => {
      logger.log(`[AGENT HUB] Ready as ${this.discord.user?.tag}`);
      this.discord.user?.setPresence({ status: 'online', activities: [{ name: 'Orchestrating' }] });
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

    try {
      await this.discord.login(token);
    } catch (error) {
      logger.error('[AGENT HUB] Failed to connect:', error);
      process.exit(1);
    }
  }

  async shutdown(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (token && this.discord.user) {
      try {
        const rest = new REST().setToken(token);
        await rest.put(Routes.applicationCommands(this.discord.user.id), { body: [] });
        logger.log('[AGENT HUB] Cleared all slash commands');
      } catch (err) {
        logger.error('[AGENT HUB] Failed to clear slash commands:', err);
      }
    }
    this.discord.destroy();
  }
}
