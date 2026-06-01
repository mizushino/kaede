import OpenAI from 'openai';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { z } from 'zod';
import type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletionUserMessageParam } from 'openai/resources/chat/completions';
import { BaseProvider, asJsonObject } from './provider.js';
import type { ContextUsageInfo, JsonObject, ProviderContext, ProviderOptions } from './provider.js';
import type { ToolContext } from '../core/tools.js';
import { createTools } from '../core/tools.js';
import { FunctionLoader } from '../core/functions.js';
import { logger } from '../core/logger.js';
import { areFunctionManagementToolsEnabled, areScheduleManagementToolsEnabled } from '../core/tool_features.js';

const DEFAULT_MAX_TOOL_ROUNDS = 12;
const DEFAULT_MODEL = 'gpt-4o-mini';
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export interface OpenAICompatibleProviderContext extends ProviderContext {
  functionLoader: FunctionLoader;
  botUserId: string;
  getModel(): string;
  createToolContext(): ToolContext;
}

type RegisteredTool = {
  name: string;
  description?: string;
  parameters?: unknown;
  handler: (args: any) => Promise<unknown>;
};

export class OpenAICompatibleProvider extends BaseProvider {
  readonly name = 'openai';

  private client: OpenAI | null = null;
  private messages: ChatCompletionMessageParam[] = [];

  constructor(protected readonly context: OpenAICompatibleProviderContext) {
    super(context);
  }

  protected getIcon(): string {
    return '🧠';
  }

  protected getDisplayName(): string {
    return 'OpenAI Compatible API';
  }

  static async listModels(): Promise<Array<{ id: string; displayName: string; effort: string }>> {
    const configured = (process.env.OPENAI_COMPAT_MODELS || process.env.OPENAI_MODELS || '').trim();
    if (configured) {
      return configured.split(',').map(id => id.trim()).filter(Boolean).map(id => ({ id, displayName: id, effort: '-' }));
    }

    try {
      const client = createOpenAIClient();
      const page = await client.models.list();
      return page.data.map(model => ({ id: model.id, displayName: model.id, effort: '-' }));
    } catch (err) {
      logger.log(`[openai] Failed to list models: ${(err as Error).message?.slice(0, 120) || 'unknown'}`);
      const fallback = (process.env.AGENT_MODEL || DEFAULT_MODEL).trim();
      return fallback ? [{ id: fallback, displayName: fallback, effort: '-' }] : [];
    }
  }

  async setModel(): Promise<void> {
    // Keep history, but subsequent calls use context.getModel().
  }

  override async getContextUsage(): Promise<ContextUsageInfo | null> {
    return null;
  }

  async sendPrompt(prompt: string, options?: ProviderOptions): Promise<void> {
    const model = options?.model || this.context.getModel() || process.env.OPENAI_MODEL || DEFAULT_MODEL;
    const toolContext = this.context.createToolContext();
    let sentDiscordMessage = false;
    const previousDelivered = toolContext.onSendMessageDelivered;
    toolContext.onSendMessageDelivered = () => {
      sentDiscordMessage = true;
      previousDelivered?.();
    };

    const rawTools = await this.buildTools(toolContext);
    const tools = rawTools.map(toolToOpenAI);
    const toolByName = new Map(rawTools.map(tool => [tool.name, tool]));

    this.ensureSystemMessage();
    this.messages.push({ role: 'user', content: this.buildUserMessageContent(prompt, options?.attachments ?? []) });

    const maxRounds = readPositiveIntegerEnv('OPENAI_COMPAT_MAX_TOOL_ROUNDS') ?? DEFAULT_MAX_TOOL_ROUNDS;
    for (let round = 0; round < maxRounds; round++) {
      const response = await this.getClient().chat.completions.create({
        model,
        messages: this.messages,
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' as const } : {}),
      });

      const choice = response.choices[0];
      const message = choice?.message;
      if (!message) throw new Error('OpenAI-compatible API returned no message');

      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length > 0) {
        this.messages.push({
          role: 'assistant',
          content: message.content ?? null,
          tool_calls: toolCalls,
        });

        let calledSendMessage = false;
        for (const toolCall of toolCalls) {
          if (toolCall.type !== 'function') continue;
          const name = toolCall.function.name;
          const args = parseToolArguments(toolCall.function.arguments);
          const detail = this.formatToolDetail(name, args);
          logger.log(`[${model}] tool: ${name}${detail ? ` | ${detail}` : ''}`);
          if (name !== 'send_message') {
            this.context.messenger.setStatus(this.formatToolStatus(name, detail || undefined));
          }

          const result = await this.invokeTool(toolByName.get(name), args);
          this.messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: stringifyToolResult(result),
          });

          if (name === 'send_message' && isDeliveredOrQueuedSendMessageResult(result)) {
            calledSendMessage = true;
          }
        }

        if (calledSendMessage) {
          this.context.messenger.clearStatus();
          this.context.messenger.stopTyping();
          return;
        }

        continue;
      }

      const content = typeof message.content === 'string' ? message.content.trim() : '';
      this.messages.push({ role: 'assistant', content: message.content ?? '' });

      if (content && !sentDiscordMessage) {
        await this.context.messenger.sendMessage(this.context.messenger.channelId, content);
        this.context.messenger.stopTyping();
        this.context.messenger.clearStatus();
      }
      return;
    }

    throw new Error(`OpenAI-compatible API exceeded tool round limit (${maxRounds})`);
  }

  dispose(): void {
    super.dispose();
  }

  async deleteSession(): Promise<void> {
    this.messages = [];
  }

  private getClient(): OpenAI {
    if (!this.client) this.client = createOpenAIClient();
    return this.client;
  }

  private ensureSystemMessage(): void {
    if (this.messages.some(message => message.role === 'system')) return;
    this.messages.unshift({ role: 'system', content: this.buildSystemMessage() });
  }

  private buildSystemMessage(): string {
    const channelId = this.context.messenger.channelId;
    return `You are a helpful AI assistant operating in a chat channel.
Your working directory is ${path.resolve(this.context.workspaceDir)}.
Use the send_message tool to respond to users. Always respond in the same language as the user's message.
You may reply to a specific message by including the messageId parameter.
The current channel ID is: ${channelId}
${this.context.botUserId ? `Your Discord user ID is: ${this.context.botUserId}` : ''}
${areFunctionManagementToolsEnabled()
  ? `\nYou have a self-modifiable function system (functions dir: ${this.context.functionLoader.functionsDir}).\nTools: list_funcs, read_func, write_func, delete_func, run_func`
  : ''}
${areScheduleManagementToolsEnabled()
  ? `\n\nYou can manage scheduled tasks (cron-based, timezone: Asia/Tokyo).\nTools: add_schedule, list_schedules, remove_schedule\nWhen users ask to schedule something, convert their request to a cron expression and use add_schedule.`
  : ''}

IMPORTANT RULES:
- ALWAYS use the send_message tool to send responses. Never output text directly without calling send_message.
- When you need clarification or want the user to choose from options, use ask_user instead of only describing a question in plain text.${this.buildAgentsMdAppend()}`;
  }


  private buildUserMessageContent(prompt: string, attachments: string[]): ChatCompletionUserMessageParam['content'] {
    const imageParts = attachments.flatMap(filePath => {
      const dataUrl = imageFileToDataUrl(filePath);
      if (!dataUrl) return [];
      return [{
        type: 'image_url' as const,
        image_url: {
          url: dataUrl,
          detail: readImageDetailEnv(),
        },
      }];
    });

    if (imageParts.length === 0) return prompt;
    return [
      { type: 'text' as const, text: prompt },
      ...imageParts,
    ] as ChatCompletionUserMessageParam['content'];
  }

  private async buildTools(toolContext: ToolContext): Promise<RegisteredTool[]> {
    const fnTools = await this.context.functionLoader.loadTools(toolContext);
    return [
      ...createTools(toolContext),
      ...this.context.functionLoader.createTools(toolContext),
      ...fnTools,
    ] as RegisteredTool[];
  }

  private async invokeTool(tool: RegisteredTool | undefined, args: JsonObject): Promise<unknown> {
    if (!tool) return { error: 'Unknown tool' };
    try {
      return await tool.handler(args);
    } catch (err) {
      return { error: (err as Error).message || String(err) };
    }
  }

  private buildAgentsMdAppend(): string {
    const agentsMdPath = process.env.AGENTS_MD_PATH?.trim();
    if (!agentsMdPath) return '';

    const resolvedPath = path.resolve(agentsMdPath);
    if (!existsSync(resolvedPath)) {
      logger.error(`[openai] AGENTS_MD_PATH not found: ${resolvedPath}`);
      return '';
    }

    try {
      const content = readFileSync(resolvedPath, 'utf8');
      logger.log(`[openai] Using custom AGENTS.md from: ${resolvedPath}`);
      return `\n\n${content}`;
    } catch (err) {
      logger.error(`[openai] Failed to read AGENTS_MD_PATH: ${err}`);
      return '';
    }
  }
}


function imageFileToDataUrl(filePath: string): string | null {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
      logger.log(`[openai] Skipping unsupported image attachment: ${filePath}`);
      return null;
    }
    if (!existsSync(filePath)) {
      logger.log(`[openai] Image attachment not found: ${filePath}`);
      return null;
    }
    const mimeType = imageMimeTypeFromExtension(ext);
    const base64 = readFileSync(filePath).toString('base64');
    return `data:${mimeType};base64,${base64}`;
  } catch (err) {
    logger.log(`[openai] Failed to read image attachment: ${(err as Error).message || String(err)}`);
    return null;
  }
}

function imageMimeTypeFromExtension(ext: string): string {
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.png':
    default:
      return 'image/png';
  }
}

function readImageDetailEnv(): 'auto' | 'low' | 'high' {
  const detail = process.env.OPENAI_COMPAT_IMAGE_DETAIL?.trim().toLowerCase();
  return detail === 'low' || detail === 'high' ? detail : 'auto';
}

function createOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY
    || process.env.OPENAI_COMPAT_API_KEY
    || process.env.COPILOT_PROVIDER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY or OPENAI_COMPAT_API_KEY is required for AGENT_PROVIDER=openai');
  }

  const baseURL = process.env.OPENAI_BASE_URL
    || process.env.OPENAI_COMPAT_BASE_URL
    || process.env.COPILOT_PROVIDER_BASE_URL
    || undefined;

  return new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
}

function toolToOpenAI(tool: RegisteredTool): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || tool.name,
      parameters: zodToJsonSchema(tool.parameters),
    },
  };
}

function zodToJsonSchema(schema: unknown): Record<string, unknown> {
  try {
    const json = z.toJSONSchema(schema as any) as Record<string, unknown>;
    delete json.$schema;
    return json;
  } catch {
    return { type: 'object', properties: {} };
  }
}

function parseToolArguments(raw: string): JsonObject {
  try {
    return asJsonObject(JSON.parse(raw || '{}')) ?? {};
  } catch {
    return {};
  }
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result ?? {}, null, 2);
  } catch {
    return String(result);
  }
}

function readPositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function isDeliveredOrQueuedSendMessageResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const value = result as { success?: unknown; queued?: unknown };
  return value.success === true || value.queued === true;
}
