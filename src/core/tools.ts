import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { Inbox } from './inbox.js';
import type { Messenger } from './messenger.js';
import type { RequestCounter } from './counter.js';
import type { Scheduler } from './scheduler.js';
import { logger } from './logger.js';

export interface ToolContext {
  model: string;
  queue: Inbox;
  messenger: Messenger;
  counter: RequestCounter;
  scheduler: Scheduler;
}

export function createTools(ctx: ToolContext) {
  return [
    defineTool('send_message', {
      description: 'Send a message to the channel (optionally as a reply). Messages over the limit will be split automatically.',
      parameters: z.object({
        channelId: z.string().describe('Channel ID'),
        content: z.string().describe('Message content to send').optional(),
        messageId: z.string().describe('Optional: Message ID to reply to').optional(),
        imagePath: z.string().describe('Optional: Path to image file to attach').optional(),
      }),
      skipPermission: true,
      handler: async ({ channelId, content, messageId, imagePath }) => {
        try {
          const messagesSent = await ctx.messenger.sendMessage(channelId, content, messageId, imagePath);
          ctx.counter.incrementSendMessage();
          ctx.messenger.stopTyping();
          return { success: true, messagesSent };
        } catch (err: unknown) {
          return { error: (err as Error).message };
        }
      },
    }),

    defineTool('get_messages', {
      description: 'Get recent messages from a channel',
      parameters: z.object({
        channelId: z.string().describe('Channel ID'),
        limit: z.number().min(1).max(100).default(10).describe('Number of messages to fetch'),
      }),
      skipPermission: true,
      handler: async ({ channelId, limit }) => {
        try {
          return await ctx.messenger.getMessages(channelId, limit);
        } catch (err: unknown) {
          return { error: (err as Error).message };
        }
      },
    }),

    defineTool('get_channels', {
      description: 'Get list of channels in a server',
      parameters: z.object({
        serverId: z.string().describe('Server ID'),
      }),
      skipPermission: true,
      handler: async ({ serverId }) => {
        try {
          return await ctx.messenger.getChannels(serverId);
        } catch (err: unknown) {
          return { error: (err as Error).message };
        }
      },
    }),

    defineTool('get_servers', {
      description: 'Get list of servers the bot is in',
      parameters: z.object({}),
      skipPermission: true,
      handler: async () => {
        return ctx.messenger.getServers();
      },
    }),

    defineTool('wait_messages', {
      description: 'Wait for new messages. Call this after responding.',
      parameters: z.object({}),
      skipPermission: true,
      handler: async () => {
        ctx.messenger.stopTyping();
        ctx.messenger.clearStatus();

        await ctx.queue.waitForMessage();

        if (ctx.queue.length === 0) {
          return { messages: [] };
        }

        await ctx.messenger.startTyping();
        ctx.messenger.setStatus('👀 check_message');

        const items = ctx.queue.drain();
        ctx.counter.addReceived(items.length);
        logger.log(`[${ctx.model}] Checking messages (${items.length})`);
        return {
          messages: items.map(item => ({
            id: item.message.id,
            channelId: item.message.channelId,
            author: item.message.author,
            content: item.message.content,
            attachments: item.attachments,
            ...(item.files.length > 0 ? { files: item.files } : {}),
          })),
        };
      },
    }),

    // --- Schedule tools ---

    defineTool('schedule_add', {
      description: 'Register a scheduled task that sends a message to a channel on a cron schedule (timezone: Asia/Tokyo)',
      parameters: z.object({
        cron: z.string().describe('Cron expression (e.g. "0 9 * * *" for every day at 9:00 AM)'),
        channelId: z.string().describe('Target channel ID to send the prompt to'),
        prompt: z.string().describe('The message/prompt to send when the schedule fires'),
        description: z.string().describe('Human-readable description of the schedule').optional(),
        guildId: z.string().describe('Optional: Server/guild ID for server-scoped sessions').optional(),
      }),
      skipPermission: true,
      handler: async ({ cron, channelId, prompt, description, guildId }) => {
        try {
          const entry = ctx.scheduler.add({ cron, channelId, prompt, description, guildId });
          return { success: true, schedule: entry };
        } catch (err: unknown) {
          return { error: (err as Error).message };
        }
      },
    }),

    defineTool('schedule_list', {
      description: 'List all registered scheduled tasks',
      parameters: z.object({}),
      skipPermission: true,
      handler: async () => {
        return { schedules: ctx.scheduler.list() };
      },
    }),

    defineTool('schedule_remove', {
      description: 'Remove a scheduled task by ID',
      parameters: z.object({
        id: z.string().describe('Schedule ID to remove'),
      }),
      skipPermission: true,
      handler: async ({ id }) => {
        const removed = ctx.scheduler.remove(id);
        return removed ? { success: true } : { error: `Schedule "${id}" not found` };
      },
    }),

    defineTool('schedule_toggle', {
      description: 'Toggle a scheduled task on/off by ID',
      parameters: z.object({
        id: z.string().describe('Schedule ID to toggle'),
      }),
      skipPermission: true,
      handler: async ({ id }) => {
        const entry = ctx.scheduler.toggle(id);
        return entry ? { success: true, schedule: entry } : { error: `Schedule "${id}" not found` };
      },
    }),
  ];
}
