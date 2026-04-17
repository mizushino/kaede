import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { Inbox } from './inbox.js';
import type { Messenger } from './messenger.js';
import { logger } from './logger.js';

export interface ToolContext {
  model: string;
  queue: Inbox;
  messenger: Messenger;
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
        logger.log(`[${ctx.model}] Checking messages (${items.length})`);
        return {
          messages: items.map(item => ({
            id: item.message.id,
            author: item.message.author,
            content: item.message.content,
            attachments: item.attachments,
            ...(item.files.length > 0 ? { files: item.files } : {}),
          })),
        };
      },
    }),
  ];
}
