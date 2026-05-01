import type { QueuedMessage } from './inbox.js';

export interface IncomingPromptOptions {
  /** Include the raw `attachments` array in the JSON message data (Claude only). */
  includeAttachments?: boolean;
  /** Template for files note. {files} is replaced with comma-joined paths. */
  fileNoteTemplate?: string;
  /** Suffix appended after the JSON + file note (provider-specific instructions). */
  suffix: string;
}

const DEFAULT_FILE_NOTE = '\n\nAttached files (use view tool to read): {files}';

export function buildIncomingMessagePrompt(items: QueuedMessage[], options: IncomingPromptOptions): string {
  const messageData = items.map(item => ({
    id: item.message.id,
    channelId: item.message.channelId,
    author: item.message.author,
    content: item.message.content,
    hasAttachments: item.attachments.length > 0,
    ...(options.includeAttachments ? { attachments: item.attachments } : {}),
    ...(item.files.length > 0 ? { files: item.files } : {}),
  }));

  const allFiles = items.flatMap(item => item.files);
  const fileNoteTemplate = options.fileNoteTemplate ?? DEFAULT_FILE_NOTE;
  const fileNote = allFiles.length > 0 ? fileNoteTemplate.replace('{files}', allFiles.join(', ')) : '';

  return `${JSON.stringify(messageData)}${fileNote}\n\n${options.suffix}`;
}
