export interface IncomingMessage {
  id: string;
  channelId: string;
  author: string;
  content: string;
}

export interface QueuedMessage {
  message: IncomingMessage;
  attachments: string[];
  files: string[];
}
