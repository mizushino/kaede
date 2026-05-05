import { filterEnabledTools } from './tool_features.js';

type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
};

export type ToolContract = {
  name: string;
  promptSignature: string;
  description: string;
  inputSchema: JsonSchema;
};

const BASE_DISCORD_TOOL_CONTRACTS: ToolContract[] = [
  {
    name: 'ask_user',
    promptSignature: 'mcp__discord__ask_user(channelId, questions)',
    description: 'Ask one or more questions in Discord and wait for the user response. Use this when you need clarification or want the user to choose from options.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID' },
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              header: { type: 'string', description: 'Short label for the question' },
              question: { type: 'string', description: 'Question text to ask the user' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                    preview: { type: 'string' },
                  },
                  required: ['label'],
                },
              },
              multiSelect: { type: 'boolean', description: 'Allow selecting multiple options' },
              allowFreeform: { type: 'boolean', description: 'Allow freeform text in addition to the options' },
            },
            required: ['header', 'question'],
          },
        },
      },
      required: ['channelId', 'questions'],
    },
  },
  {
    name: 'send_message',
    promptSignature: 'mcp__discord__send_message(channelId, content, messageId?)',
    description: 'Send a message or image to Discord. Optionally reply to an existing message.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID' },
        content: { type: 'string', description: 'Message content' },
        messageId: { type: 'string', description: 'Message ID to reply to' },
        imagePath: { type: 'string', description: 'Path to an image file to upload' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'get_messages',
    promptSignature: 'mcp__discord__get_messages(channelId, limit)',
    description: 'Get recent messages from a Discord channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Discord channel ID' },
        limit: { type: 'number', minimum: 1, maximum: 100, default: 10 },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'get_channels',
    promptSignature: 'mcp__discord__get_channels(serverId)',
    description: 'Get channels in a Discord server.',
    inputSchema: {
      type: 'object',
      properties: {
        serverId: { type: 'string', description: 'Discord server ID' },
      },
      required: ['serverId'],
    },
  },
  {
    name: 'list_funcs',
    promptSignature: 'mcp__discord__list_funcs()',
    description: 'List installed functions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_func',
    promptSignature: 'mcp__discord__read_func(filename)',
    description: 'Read a function file\'s source code.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Function filename' },
      },
      required: ['filename'],
    },
  },
  {
    name: 'write_func',
    promptSignature: 'mcp__discord__write_func(filename, content)',
    description: 'Create or overwrite a function file.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Function filename' },
        content: { type: 'string', description: 'Full TypeScript source' },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'delete_func',
    promptSignature: 'mcp__discord__delete_func(filename)',
    description: 'Delete a function file.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Function filename' },
      },
      required: ['filename'],
    },
  },
  {
    name: 'run_func',
    promptSignature: 'mcp__discord__run_func(filename, tool, args)',
    description: 'Run a tool from a function file.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Function filename' },
        tool: { type: 'string', description: 'Tool name to invoke' },
        args: { type: 'object', description: 'Tool arguments' },
      },
      required: ['filename', 'tool'],
    },
  },
  {
    name: 'add_schedule',
    promptSignature: 'mcp__discord__add_schedule(cron, channelId, prompt, description?, guildId?)',
    description: 'Register a scheduled task that sends a message to a channel on a cron schedule (timezone: Asia/Tokyo).',
    inputSchema: {
      type: 'object',
      properties: {
        cron: { type: 'string', description: 'Cron expression' },
        channelId: { type: 'string', description: 'Target channel ID to send the prompt to' },
        prompt: { type: 'string', description: 'The message/prompt to send when the schedule fires' },
        description: { type: 'string', description: 'Human-readable description of the schedule' },
        guildId: { type: 'string', description: 'Optional server/guild ID for server-scoped sessions' },
      },
      required: ['cron', 'channelId', 'prompt'],
    },
  },
  {
    name: 'list_schedules',
    promptSignature: 'mcp__discord__list_schedules()',
    description: 'List all registered scheduled tasks.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'remove_schedule',
    promptSignature: 'mcp__discord__remove_schedule(id)',
    description: 'Remove a scheduled task by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Schedule ID to remove' },
      },
      required: ['id'],
    },
  },
];

export function getDiscordToolContracts(): ToolContract[] {
  return filterEnabledTools(BASE_DISCORD_TOOL_CONTRACTS);
}

export function getClaudeDiscordAllowedTools(): string[] {
  return getDiscordToolContracts().map(tool => `mcp__discord__${tool.name}`);
}

export function getClaudeDiscordPromptSignatures(): string[] {
  return getDiscordToolContracts().map(tool => `- ${tool.promptSignature}`);
}
