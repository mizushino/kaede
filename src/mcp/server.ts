#!/usr/bin/env node
import '../load-env.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { Client, GatewayIntentBits, TextChannel, ThreadChannel, AttachmentBuilder, Message } from 'discord.js';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { getDiscordToolContracts } from '../core/tool_contract.js';
import { isDiscordToolEnabled } from '../core/tool_features.js';
import { enqueueDeferredReply, readPendingQueueSnapshot } from '../core/queue_state.js';
import { logger } from '../core/logger.js';

const WORKSPACE_DIR = path.resolve(process.env.WORKSPACE_DIR || 'workspace');
const FUNCTIONS_DIR = path.resolve(process.env.FUNCTIONS_DIR || path.join(WORKSPACE_DIR, 'functions'));
const AGENT_NAME = process.env.AGENT_NAME || 'agent';
const CONFIG_DIR = path.resolve(process.env.CONFIG_DIR || path.join('.kaede', AGENT_NAME));
const SCHEDULES_PATH = path.join(CONFIG_DIR, 'schedules.json');
const TEMPORARY_DIR = path.resolve(process.env.TEMPORARY_DIR || 'tmp');
const MCP_SESSION_KEY = process.env.KAEDE_SESSION_KEY || '';

const SendMessageSchema = z.object({
  channelId: z.string(),
  content: z.string().optional(),
  messageId: z.string().optional(),
  imagePath: z.string().optional(),
}).refine(data => data.content || data.imagePath, {
  message: 'Either content or imagePath must be provided',
});

const GetMessagesSchema = z.object({
  channelId: z.string(),
  limit: z.number().min(1).max(100).default(10),
});

const GetChannelsSchema = z.object({
  serverId: z.string(),
});

const AskUserOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
  preview: z.string().optional(),
});

const AskUserQuestionSchema = z.object({
  header: z.string().min(1).max(50).default('質問'),
  question: z.string().min(1),
  options: z.array(AskUserOptionSchema).min(2).max(10).optional(),
  multiSelect: z.boolean().default(false),
  allowFreeform: z.boolean().optional(),
});

const AskUserSchema = z.object({
  channelId: z.string(),
  questions: z.array(AskUserQuestionSchema).min(1).max(4),
});

const ScheduleAddSchema = z.object({
  cron: z.string(),
  channelId: z.string(),
  prompt: z.string(),
  description: z.string().optional(),
  guildId: z.string().optional(),
});

const ScheduleIdSchema = z.object({
  id: z.string(),
});

const FunctionFilenameSchema = z.object({
  filename: z.string(),
});

const WriteFunctionSchema = z.object({
  filename: z.string(),
  content: z.string(),
});

const RunFunctionSchema = z.object({
  filename: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
});

type ScheduleEntry = {
  id: string;
  cron: string;
  channelId: string;
  guildId?: string;
  prompt: string;
  description?: string;
  enabled: boolean;
};

type RawTool = {
  name: string;
  description: string;
  handler: (args: any) => Promise<unknown>;
};

const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const USER_RESPONSE_TIMEOUT_MS = Number(process.env.USER_RESPONSE_TIMEOUT_MS) || 300_000;

class KaedeMcpServer {
  private readonly server: Server;
  private readonly discord: Client;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;

  constructor() {
    this.server = new Server(
      { name: 'kaede-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    this.discord = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    this.readyPromise = new Promise<void>(resolve => {
      this.resolveReady = resolve;
    });

    this.setupHandlers();
  }

  async run(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      throw new Error('DISCORD_BOT_TOKEN is not set');
    }

    this.discord.once('clientReady', () => {
      this.resolveReady();
      console.error(`[MCP] Discord bot logged in as ${this.discord.user?.tag}`);
    });

    await this.discord.login(token);
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('[MCP] Kaede MCP server running on stdio');
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: getDiscordToolContracts().map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      await this.readyPromise;

      try {
        if (!isDiscordToolEnabled(request.params.name)) {
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }
        switch (request.params.name) {
          case 'send_message':
            return await this.sendMessage(request.params.arguments);
          case 'get_messages':
            return await this.getMessages(request.params.arguments);
          case 'get_channels':
            return await this.getChannels(request.params.arguments);
          case 'ask_user':
            return await this.askUser(request.params.arguments);
          case 'add_schedule':
            return await this.addSchedule(request.params.arguments);
          case 'list_schedules':
            return await this.listSchedules();
          case 'remove_schedule':
            return await this.removeSchedule(request.params.arguments);
          case 'list_funcs':
            return await this.listFuncs();
          case 'read_func':
            return await this.readFunc(request.params.arguments);
          case 'write_func':
            return await this.writeFunc(request.params.arguments);
          case 'delete_func':
            return await this.deleteFunc(request.params.arguments);
          case 'run_func':
            return await this.runFunc(request.params.arguments);
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }
      } catch (err) {
        if (err instanceof McpError) throw err;
        throw new McpError(ErrorCode.InternalError, err instanceof Error ? err.message : String(err));
      }
    });
  }

  private async sendMessage(args: unknown) {
    const parsed = SendMessageSchema.parse(args);
    const pending = await this.readCurrentPendingQueue();
    if (pending.pendingCount > 0) {
      if (MCP_SESSION_KEY) {
        try {
          await enqueueDeferredReply(MCP_SESSION_KEY, {
            id: `deferred-${Date.now()}`,
            channelId: parsed.channelId,
            ...(parsed.content ? { content: parsed.content } : {}),
            ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
            ...(parsed.imagePath ? { imagePath: parsed.imagePath } : {}),
            createdAt: new Date().toISOString(),
          }, TEMPORARY_DIR);
        } catch (err) {
          logger.error(`[mcp] Failed to persist deferred reply for ${MCP_SESSION_KEY}:`, err);
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            queued: true,
            reason: 'new_messages_waiting',
            pendingCount: pending.pendingCount,
            messages: pending.messages,
          }, null, 2),
        }],
      };
    }

    const channel = await this.discord.channels.fetch(parsed.channelId);
    if (!(channel instanceof TextChannel || channel instanceof ThreadChannel)) {
      throw new Error('Channel not found or not a text channel');
    }

    const options: { content?: string; files?: AttachmentBuilder[] } = {};
    if (parsed.content) options.content = parsed.content;
    if (parsed.imagePath) {
      await fs.access(parsed.imagePath);
      options.files = [new AttachmentBuilder(parsed.imagePath, { name: path.basename(parsed.imagePath) })];
    }

    const sent = parsed.messageId
      ? await (await channel.messages.fetch(parsed.messageId)).reply(options)
      : await channel.send(options);

    return {
      content: [{ type: 'text' as const, text: `Message sent successfully. Message ID: ${sent.id}` }],
    };
  }

  private async getMessages(args: unknown) {
    const parsed = GetMessagesSchema.parse(args);
    const channel = await this.discord.channels.fetch(parsed.channelId);
    if (!(channel instanceof TextChannel || channel instanceof ThreadChannel)) {
      throw new Error('Channel not found or not a text channel');
    }

    const messages = await channel.messages.fetch({ limit: parsed.limit });
    const data = Array.from(messages.values()).map(message => ({
      id: message.id,
      author: {
        id: message.author.id,
        username: message.author.username,
        bot: message.author.bot,
      },
      content: message.content,
      timestamp: message.createdAt.toISOString(),
      attachments: message.attachments.map(attachment => ({
        name: attachment.name,
        url: attachment.url,
        size: attachment.size,
      })),
    }));

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }

  private async getChannels(args: unknown) {
    const parsed = GetChannelsSchema.parse(args);
    const guild = await this.discord.guilds.fetch(parsed.serverId);
    const channels = await guild.channels.fetch();
    const data = Array.from(channels.values())
      .filter(channel => channel !== null)
      .map(channel => ({
        id: channel.id,
        name: channel.name,
        type: channel.type,
      }));

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }

  private async askUser(args: unknown) {
    const parsed = AskUserSchema.parse(args);
    const channel = await this.discord.channels.fetch(parsed.channelId);
    if (!(channel instanceof TextChannel || channel instanceof ThreadChannel)) {
      throw new Error('Channel not found or not a text channel');
    }

    const responses = [];
    for (const question of parsed.questions) {
      responses.push(await this.askQuestion(channel, question));
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ responses }, null, 2) }],
    };
  }

  private async askQuestion(
    channel: TextChannel | ThreadChannel,
    question: z.infer<typeof AskUserQuestionSchema>,
  ): Promise<Record<string, unknown>> {
    const botId = this.discord.user?.id;
    const options = question.options ?? [];
    const hasChoices = options.length > 0;
    const canFreeform = question.allowFreeform ?? true;

    let prompt = `❓ **${question.header}**\n${question.question}`;
    if (hasChoices) {
      prompt += '\n\n' + options.map((option, index) => {
        const marker = NUMBER_EMOJIS[index] ?? `${index + 1}.`;
        const description = option.description ? ` - ${option.description}` : '';
        return `${marker} ${option.label}${description}`;
      }).join('\n');
    }

    if (question.multiSelect) {
      prompt += '\n\n💬 複数選択する場合は番号やラベルをカンマ区切りで送信してください';
    } else if (hasChoices && canFreeform) {
      prompt += '\n\n💬 リアクションで選択、またはメッセージで自由回答';
    }

    const promptMessage = await channel.send(prompt);

    return new Promise<Record<string, unknown>>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const reactionCollector = (hasChoices && !question.multiSelect)
        ? promptMessage.createReactionCollector({
            filter: (reaction, user) => {
              if (user.id === botId) return false;
              const idx = this.getChoiceIndexFromReaction(reaction);
              return idx >= 0 && idx < options.length;
            },
            max: 1,
            time: USER_RESPONSE_TIMEOUT_MS,
          })
        : null;

      const messageCollector = channel.createMessageCollector({
        filter: (m: Message) => m.author.id !== botId,
        max: 1,
        time: USER_RESPONSE_TIMEOUT_MS,
      });

      const finalize = (summary: string, payload: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        try {
          reactionCollector?.stop('settled');
          messageCollector.stop('settled');
          void promptMessage.reactions.removeAll().catch(() => {});
          void promptMessage.edit(`${prompt}\n\n**→ ${summary}**`).catch(() => {});
        } catch (err) {
          void err;
        }
        resolve({
          header: question.header,
          question: question.question,
          ...payload,
        });
      };

      timer = setTimeout(() => {
        finalize('⏰ タイムアウト', {
          answer: '',
          answers: [],
          wasFreeform: true,
          timedOut: true,
        });
      }, USER_RESPONSE_TIMEOUT_MS);

      reactionCollector?.on('collect', (reaction) => {
        const index = this.getChoiceIndexFromReaction(reaction);
        const answer = index >= 0 && index < options.length ? options[index].label : '';
        finalize(answer || '未選択', {
          answer,
          answers: answer ? [answer] : [],
          wasFreeform: false,
        });
      });

      messageCollector.on('collect', (collected) => {
        const rawAnswer = collected.content ?? '';

        if (question.multiSelect) {
          const answers = this.parseMultiSelectAnswer(rawAnswer, options.map(option => option.label));
          finalize(`💬 ${answers.join(', ').slice(0, 120) || rawAnswer.slice(0, 120)}`, {
            answer: rawAnswer,
            answers,
            wasFreeform: answers.length === 0,
          });
          return;
        }

        const choiceIndex = hasChoices ? this.getChoiceIndexFromMessage(rawAnswer) : -1;
        const answer = choiceIndex >= 0 && choiceIndex < options.length ? options[choiceIndex].label : rawAnswer;
        finalize(`💬 ${answer.slice(0, 120)}`, {
          answer,
          answers: answer ? [answer] : [],
          wasFreeform: choiceIndex < 0,
        });
      });

      if (hasChoices && !question.multiSelect) {
        void (async () => {
          for (let index = 0; index < Math.min(options.length, NUMBER_EMOJIS.length); index++) {
            if (settled) break;
            await promptMessage.react(NUMBER_EMOJIS[index]).catch(() => {});
          }
        })();
      }
    });
  }

  private getChoiceIndexFromReaction(reaction: { emoji: { name?: string | null; toString(): string } }): number {
    const candidates = [reaction.emoji.name ?? '', reaction.emoji.toString?.() ?? '']
      .map(value => value.replace(/\uFE0F|\u20E3/g, ''))
      .filter(Boolean);

    for (const candidate of candidates) {
      if (candidate === '🔟') return 9;
      if (/^[1-9]$/.test(candidate)) return Number(candidate) - 1;
    }

    return -1;
  }

  private getChoiceIndexFromMessage(value: string): number {
    const normalized = value.trim().replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
    if (normalized === '10') return 9;
    if (/^[1-9]$/.test(normalized)) return Number(normalized) - 1;
    return -1;
  }

  private parseMultiSelectAnswer(value: string, labels: string[]): string[] {
    const parts = value.split(/[\n,、，]+/).map(part => part.trim()).filter(Boolean);
    const selected = new Set<string>();

    for (const part of parts) {
      const choiceIndex = this.getChoiceIndexFromMessage(part);
      if (choiceIndex >= 0 && choiceIndex < labels.length) {
        selected.add(labels[choiceIndex]);
        continue;
      }

      const matched = labels.find(label => label.toLowerCase() === part.toLowerCase());
      if (matched) {
        selected.add(matched);
      }
    }

    return [...selected];
  }

  private async addSchedule(args: unknown) {
    const parsed = ScheduleAddSchema.parse(args);
    const schedules = await this.readSchedules();
    const entry: ScheduleEntry = {
      id: `sched_${Date.now().toString(36)}`,
      cron: parsed.cron,
      channelId: parsed.channelId,
      guildId: parsed.guildId,
      prompt: parsed.prompt,
      description: parsed.description,
      enabled: true,
    };

    schedules.push(entry);
    await this.writeSchedules(schedules);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true, schedule: entry }, null, 2) }],
    };
  }

  private async listSchedules() {
    const schedules = await this.readSchedules();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ schedules }, null, 2) }],
    };
  }

  private async removeSchedule(args: unknown) {
    const parsed = ScheduleIdSchema.parse(args);
    const schedules = await this.readSchedules();
    const next = schedules.filter(entry => entry.id !== parsed.id);
    const removed = next.length !== schedules.length;
    if (removed) await this.writeSchedules(next);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(removed ? { success: true } : { error: `Schedule "${parsed.id}" not found` }, null, 2) }],
    };
  }

  private async listFuncs() {
    const files = await this.listFunctionFiles();
    const functions = [] as Array<{ file: string; name?: string; description?: string }>;

    for (const file of files) {
      const meta: { file: string; name?: string; description?: string } = { file };
      try {
        const source = await fs.readFile(path.join(FUNCTIONS_DIR, file), 'utf-8');
        meta.name = source.match(/export\s+const\s+name\s*=\s*['"`]([^'"`]+)['"`]/)?.[1];
        meta.description = source.match(/export\s+const\s+description\s*=\s*['"`]([^'"`]+)['"`]/)?.[1];
      } catch {}
      functions.push(meta);
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ functions }, null, 2) }],
    };
  }

  private async readFunc(args: unknown) {
    const parsed = FunctionFilenameSchema.parse(args);
    const filename = this.sanitizeFilename(parsed.filename);
    const content = await fs.readFile(path.join(FUNCTIONS_DIR, filename), 'utf-8');
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ content }, null, 2) }],
    };
  }

  private async writeFunc(args: unknown) {
    const parsed = WriteFunctionSchema.parse(args);
    const filename = this.sanitizeFilename(parsed.filename);
    if (!/\.(ts|js|mjs)$/.test(filename)) {
      throw new Error('Must end in .ts/.js/.mjs');
    }

    await fs.mkdir(FUNCTIONS_DIR, { recursive: true });
    const filePath = path.join(FUNCTIONS_DIR, filename);
    await fs.writeFile(filePath, parsed.content, 'utf-8');
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true, path: filePath }, null, 2) }],
    };
  }

  private async deleteFunc(args: unknown) {
    const parsed = FunctionFilenameSchema.parse(args);
    const filename = this.sanitizeFilename(parsed.filename);
    await fs.unlink(path.join(FUNCTIONS_DIR, filename));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true }, null, 2) }],
    };
  }

  private async runFunc(args: unknown) {
    const parsed = RunFunctionSchema.parse(args);
    const filename = this.sanitizeFilename(parsed.filename);
    const tools = await this.importFunctionTools(filename);
    const tool = tools.find(item => item.name === parsed.tool);
    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: `Tool '${parsed.tool}' not found. Available: ${tools.map(item => item.name).join(', ')}` }, null, 2) }],
      };
    }

    const result = await tool.handler(parsed.args ?? {});
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  }

  private async readSchedules(): Promise<ScheduleEntry[]> {
    try {
      const content = await fs.readFile(SCHEDULES_PATH, 'utf-8');
      const data = JSON.parse(content);
      return Array.isArray(data) ? data as ScheduleEntry[] : [];
    } catch {
      return [];
    }
  }

  private async writeSchedules(entries: ScheduleEntry[]): Promise<void> {
    await fs.mkdir(WORKSPACE_DIR, { recursive: true });
    await fs.writeFile(SCHEDULES_PATH, JSON.stringify(entries, null, 2), 'utf-8');
  }

  private async readCurrentPendingQueue() {
    if (!MCP_SESSION_KEY) {
      return {
        sessionKey: '',
        updatedAt: new Date(0).toISOString(),
        pendingCount: 0,
        messages: [],
      };
    }

    return await readPendingQueueSnapshot(MCP_SESSION_KEY, TEMPORARY_DIR);
  }

  private sanitizeFilename(filename: string): string {
    return path.basename(filename);
  }

  private async listFunctionFiles(): Promise<string[]> {
    try {
      await fs.mkdir(FUNCTIONS_DIR, { recursive: true });
      const entries = await fs.readdir(FUNCTIONS_DIR);
      return entries.filter(entry => /\.(ts|js|mjs)$/.test(entry));
    } catch {
      return [];
    }
  }

  private async importFunctionTools(file: string): Promise<RawTool[]> {
    const filePath = path.join(FUNCTIONS_DIR, file);
    const mod = await import(`${filePath}?t=${Date.now()}`);
    if (typeof mod.createTools !== 'function') return [];
    const tools = mod.createTools({});
    return Array.isArray(tools) ? tools as RawTool[] : [];
  }
}

new KaedeMcpServer().run().catch((err) => {
  console.error('[MCP] Failed to start:', err);
  process.exit(1);
});
