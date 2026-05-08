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

export class OrchestratorBot {
  readonly discord: Client;
  private readonly workspaceDir: string;

  constructor() {
    this.workspaceDir = process.env.WORKSPACE_DIR || 'workspace';
    this.discord = new Client({
      intents: [
        GatewayIntentBits.Guilds,
      ],
    });
  }

  private async getBotTargets(focused: string): Promise<string[]> {
    const { readdir } = await import('fs/promises');
    const projectRoot = path.resolve(this.workspaceDir, '..');
    try {
      const allFiles = await readdir(projectRoot);
      const envFiles = allFiles.filter(f => /^\.env\..+/.test(f));
      
      const targets = envFiles.map(f => f.replace(/^\.env\./, ''));
      // Add 'default' for standard .env if exists
      if (fs.existsSync(path.join(projectRoot, '.env'))) {
        targets.push('default');
      }
      return targets.filter(t => t.toLowerCase().includes(focused) && t !== 'orchestrator');
    } catch {
      return [];
    }
  }

  private async registerSlashCommands(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token || !this.discord.user) return;

    const commands = [
      new SlashCommandBuilder()
        .setName('clear')
        .setDescription('Clear the AI session for a specific bot')
        .addStringOption(opt =>
          opt.setName('target')
            .setDescription('The target bot to clear (e.g. sumire)')
            .setRequired(true)
            .setAutocomplete(true)),
      new SlashCommandBuilder()
        .setName('restart')
        .setDescription('Restart a specific bot process')
        .addStringOption(opt =>
          opt.setName('target')
            .setDescription('The target bot to restart (e.g. sumire)')
            .setRequired(true)
            .setAutocomplete(true)),
    ];

    const rest = new REST().setToken(token);
    try {
      const commandsJSON = commands.map(cmd => cmd.toJSON());
      logger.log(`[ORCHESTRATOR] Registering ${commands.length} slash commands...`);
      await rest.put(Routes.applicationCommands(this.discord.user.id), { body: commandsJSON });
      logger.log(`[ORCHESTRATOR] Successfully registered commands.`);
    } catch (err) {
      logger.error('[ORCHESTRATOR] Failed to register commands:', err);
    }
  }

  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused().toLowerCase();
    
    if (interaction.commandName === 'clear' || interaction.commandName === 'restart') {
      const targets = await this.getBotTargets(focused);
      await interaction.respond(targets.slice(0, 25).map(t => ({ name: t, value: t })));
    }
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName === 'clear') {
      await interaction.deferReply();
      const target = interaction.options.getString('target', true);
      
      const sessionKey = `${interaction.channelId}:${interaction.guildId || 'noguild'}`;
      
      // Determine config dir for the target
      // By default, Kaede stores it in .kaede/<agent_name>
      // We assume target == agent_name for this IPC
      const configDir = path.resolve('.kaede', target);
      const ipcDir = path.join(configDir, 'ipc');
      
      try {
        fs.mkdirSync(ipcDir, { recursive: true });
        fs.writeFileSync(path.join(ipcDir, `clear_${sessionKey}`), '');
        await interaction.editReply(`✅ Sent clear signal to \`${target}\` for this channel.`);
      } catch (err) {
        logger.error(`[ORCHESTRATOR] IPC error:`, err);
        await interaction.editReply(`❌ Failed to send clear signal to \`${target}\`.`);
      }
      return;
    }

    if (interaction.commandName === 'restart') {
      await interaction.deferReply();
      const target = interaction.options.getString('target', true);

      const pm2Target = target === 'default' ? 'kaede' : target; // Assuming the PM2 app name matches the target name, or default=kaede. 
      // Actually, users might use their own pm2 names. But let's assume standard names.
      
      try {
        execSync(
          `nohup bash -c 'sleep 1 && pm2 restart ${pm2Target} --update-env' > /dev/null 2>&1 &`,
          { stdio: 'pipe' },
        );
        await interaction.editReply(`🔄 Restarting PM2 process \`${pm2Target}\`...`);
      } catch (err) {
        logger.error('[ORCHESTRATOR] Failed to restart:', err);
        await interaction.editReply(`❌ Failed to restart \`${pm2Target}\`. Is it running under PM2?`);
      }
      return;
    }
  }

  async start(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      logger.error('[ORCHESTRATOR] No token found in environment');
      process.exit(1);
    }

    this.discord.once('clientReady', async () => {
      logger.log(`[ORCHESTRATOR] Ready as ${this.discord.user?.tag}`);
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
      logger.error('[ORCHESTRATOR] Failed to connect:', error);
      process.exit(1);
    }
  }

  async shutdown(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (token && this.discord.user) {
      try {
        const rest = new REST().setToken(token);
        await rest.put(Routes.applicationCommands(this.discord.user.id), { body: [] });
        logger.log('[ORCHESTRATOR] Cleared all slash commands');
      } catch (err) {
        logger.error('[ORCHESTRATOR] Failed to clear slash commands:', err);
      }
    }
    this.discord.destroy();
  }
}
