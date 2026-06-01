import { defineTool } from '@github/copilot-sdk';
import type { ToolResultObject } from '@github/copilot-sdk';
import { z } from 'zod';
import type { QueuedMessage } from './messages.js';
import type { Messenger } from './messenger.js';
import type { RequestCounter } from './counter.js';
import type { Scheduler } from './scheduler.js';
import { logger } from './logger.js';
import { buildDeferredReplyMarker } from './queue_state.js';
import { areScheduleManagementToolsEnabled } from './tool_features.js';

function hasInternalSummary(content?: string): boolean {
  if (!content) return false;
  return /overview/i.test(content) && /checkpoint[_\s]title/i.test(content);
}

export interface ToolContext {
  model: string;
  queue: QueuedMessage[];
  messenger: Messenger;
  counter: RequestCounter;
  scheduler: Scheduler;
}

function toolSuccess(value: unknown): ToolResultObject {
  return {
    textResultForLlm: typeof value === 'string' ? value : JSON.stringify(value),
    resultType: 'success',
  };
}

function toolFailure(message: string): ToolResultObject {
  return {
    textResultForLlm: message,
    resultType: 'failure',
    error: message,
  };
}

export function createTools(ctx: ToolContext) {
  const tools = [
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
        if (hasInternalSummary(content)) {
          logger.log(`[${ctx.model}] Blocked send_message because content matched internal summary markers`);
          ctx.messenger.stopTyping();
          return toolSuccess({ success: true, messagesSent: 1 });
        }

        if (ctx.queue.length > 0) {
          const unsentMarker = buildDeferredReplyMarker({ channelId, content, messageId, imagePath });

          ctx.queue.unshift({
            message: {
              id: `unsent-${Date.now()}`,
              channelId,
              author: ctx.model,
              content: unsentMarker,
            },
            attachments: [],
            files: [],
          });

          logger.log(`[${ctx.model}] Deferred send_message because ${ctx.queue.length - 1} newer message(s) were queued`);
          ctx.messenger.stopTyping();
          return toolSuccess({ queued: true, reason: 'new_messages_waiting', pendingMessages: ctx.queue.length - 1 });
        }

        try {
          const messagesSent = await ctx.messenger.sendMessage(channelId, content, messageId, imagePath);
          ctx.counter.incrementSendMessage();
          ctx.messenger.stopTyping();
          return toolSuccess({ success: true, messagesSent });
        } catch (err: unknown) {
          return toolFailure((err as Error).message);
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
          return toolSuccess(await ctx.messenger.getMessages(channelId, limit));
        } catch (err: unknown) {
          return toolFailure((err as Error).message);
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
          return toolSuccess(await ctx.messenger.getChannels(serverId));
        } catch (err: unknown) {
          return toolFailure((err as Error).message);
        }
      },
    }),

  ];

  if (areScheduleManagementToolsEnabled()) {
    return [
      ...tools,
      defineTool('add_schedule', {
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
            return toolSuccess({ success: true, schedule: entry });
          } catch (err: unknown) {
            return toolFailure((err as Error).message);
          }
        },
      }),
      defineTool('list_schedules', {
        description: 'List all registered scheduled tasks',
        parameters: z.object({}),
        skipPermission: true,
        handler: async () => {
          return toolSuccess({ schedules: ctx.scheduler.list() });
        },
      }),
      defineTool('remove_schedule', {
        description: 'Remove a scheduled task by ID',
        parameters: z.object({
          id: z.string().describe('Schedule ID to remove'),
        }),
        skipPermission: true,
        handler: async ({ id }) => {
          const removed = ctx.scheduler.remove(id);
          return removed ? toolSuccess({ success: true }) : toolFailure(`Schedule "${id}" not found`);
        },
      }),
    ];
  }

  return tools;
}
