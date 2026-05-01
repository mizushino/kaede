import fs from 'fs/promises';
import path from 'path';

export type PendingQueueMessage = {
  id: string;
  channelId: string;
  author: string;
  content: string;
  attachments: string[];
  files: string[];
};

export type PendingQueueSnapshot = {
  sessionKey: string;
  updatedAt: string;
  pendingCount: number;
  messages: PendingQueueMessage[];
};

export type DeferredReply = {
  id: string;
  channelId: string;
  content?: string;
  messageId?: string;
  imagePath?: string;
  createdAt: string;
};

export function buildDeferredReplyMarker(reply: {
  channelId: string;
  content?: string;
  messageId?: string;
  imagePath?: string;
}): string {
  return [
    '[UNSENT MESSAGE]',
    'send_message was not delivered to Discord because newer queued messages were waiting.',
    `channelId: ${reply.channelId}`,
    ...(reply.messageId ? [`replyToMessageId: ${reply.messageId}`] : []),
    ...(reply.imagePath ? [`imagePath: ${reply.imagePath}`] : []),
    `content: ${reply.content ?? ''}`,
  ].join('\n');
}

const DEFAULT_TEMPORARY_DIR = path.resolve(process.env.TEMPORARY_DIR || 'tmp');
const SNAPSHOT_DIRNAME = 'pending-queues';
const DEFERRED_REPLY_DIRNAME = 'deferred-replies';

function sanitizeSessionKey(sessionKey: string): string {
  return encodeURIComponent(sessionKey);
}

export function getPendingQueueFilePath(sessionKey: string, temporaryDir = DEFAULT_TEMPORARY_DIR): string {
  return path.join(path.resolve(temporaryDir), SNAPSHOT_DIRNAME, `${sanitizeSessionKey(sessionKey)}.json`);
}

function getDeferredReplyFilePath(sessionKey: string, temporaryDir = DEFAULT_TEMPORARY_DIR): string {
  return path.join(path.resolve(temporaryDir), DEFERRED_REPLY_DIRNAME, `${sanitizeSessionKey(sessionKey)}.json`);
}

export async function writePendingQueueSnapshot(
  sessionKey: string,
  messages: PendingQueueMessage[],
  temporaryDir = DEFAULT_TEMPORARY_DIR,
): Promise<void> {
  const filePath = getPendingQueueFilePath(sessionKey, temporaryDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const snapshot: PendingQueueSnapshot = {
    sessionKey,
    updatedAt: new Date().toISOString(),
    pendingCount: messages.length,
    messages,
  };

  await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
}

export async function readPendingQueueSnapshot(
  sessionKey: string,
  temporaryDir = DEFAULT_TEMPORARY_DIR,
): Promise<PendingQueueSnapshot> {
  const filePath = getPendingQueueFilePath(sessionKey, temporaryDir);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content) as Partial<PendingQueueSnapshot>;
    return {
      sessionKey,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date(0).toISOString(),
      pendingCount: Array.isArray(data.messages) ? data.messages.length : Number(data.pendingCount) || 0,
      messages: Array.isArray(data.messages) ? data.messages.map(message => ({
        id: String(message.id ?? ''),
        channelId: String(message.channelId ?? ''),
        author: String(message.author ?? ''),
        content: String(message.content ?? ''),
        attachments: Array.isArray(message.attachments) ? message.attachments.map(String) : [],
        files: Array.isArray(message.files) ? message.files.map(String) : [],
      })) : [],
    };
  } catch {
    return {
      sessionKey,
      updatedAt: new Date(0).toISOString(),
      pendingCount: 0,
      messages: [],
    };
  }
}

export async function enqueueDeferredReply(
  sessionKey: string,
  reply: DeferredReply,
  temporaryDir = DEFAULT_TEMPORARY_DIR,
): Promise<void> {
  const filePath = getDeferredReplyFilePath(sessionKey, temporaryDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const existing = await readDeferredReplies(sessionKey, temporaryDir);
  const next = [reply, ...existing];
  await fs.writeFile(filePath, JSON.stringify(next, null, 2), 'utf-8');
}

export async function readDeferredReplies(
  sessionKey: string,
  temporaryDir = DEFAULT_TEMPORARY_DIR,
): Promise<DeferredReply[]> {
  const filePath = getDeferredReplyFilePath(sessionKey, temporaryDir);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    if (!Array.isArray(data)) return [];

    return data.map(item => ({
      id: String(item.id ?? ''),
      channelId: String(item.channelId ?? ''),
      ...(item.content ? { content: String(item.content) } : {}),
      ...(item.messageId ? { messageId: String(item.messageId) } : {}),
      ...(item.imagePath ? { imagePath: String(item.imagePath) } : {}),
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
    }));
  } catch {
    return [];
  }
}

export async function consumeDeferredReplies(
  sessionKey: string,
  temporaryDir = DEFAULT_TEMPORARY_DIR,
): Promise<DeferredReply[]> {
  const filePath = getDeferredReplyFilePath(sessionKey, temporaryDir);
  const replies = await readDeferredReplies(sessionKey, temporaryDir);

  try {
    await fs.unlink(filePath);
  } catch {
    // ignore missing file
  }

  return replies;
}