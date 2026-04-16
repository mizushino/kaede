export interface MessageInfo {
  id: string;
  author: string;
  content: string;
  timestamp: string;
}

export interface ChannelInfo {
  id: string;
  name: string;
  type: number;
}

export interface ServerInfo {
  id: string;
  name: string;
  memberCount: number;
}

const TYPING_INTERVAL = 8_000;
const MESSAGE_MAX_LENGTH = 2000;
const STATUS_THROTTLE_MS = 1000;

export abstract class Messenger {
  abstract readonly channelId: string;

  // --- Message operations (platform-specific) ---

  abstract sendMessage(channelId: string, content?: string, replyTo?: string, imagePath?: string): Promise<number>;
  abstract getMessages(channelId: string, limit: number): Promise<MessageInfo[]>;
  abstract getChannels(serverId: string): Promise<ChannelInfo[]>;
  abstract getServers(): ServerInfo[];
  abstract sendError(message: string): Promise<void>;

  /**
   * Request user approval via platform-specific mechanism (e.g. Discord reactions).
   * Returns true if approved, false if denied.
   * Throws on timeout.
   */
  abstract requestApproval(prompt: string, timeoutMs: number): Promise<boolean>;

  /**
   * Request user input via platform-specific mechanism (e.g. Discord reactions/messages).
   * Returns { answer, wasFreeform }.
   */
  abstract requestUserInput(question: string, choices?: string[], allowFreeform?: boolean): Promise<{ answer: string; wasFreeform: boolean }>;

  // --- Platform hooks (override in subclass) ---

  protected abstract applyStatus(text: string): void;
  protected abstract applyIdle(): void;
  protected abstract sendTypingIndicator(): Promise<void>;

  // --- Typing indicator (shared logic) ---

  private typingInterval: NodeJS.Timeout | null = null;

  async startTyping(): Promise<void> {
    this.stopTyping();
    try {
      await this.sendTypingIndicator();
      this.typingInterval = setInterval(async () => {
        try {
          await this.sendTypingIndicator();
        } catch {
          this.stopTyping();
        }
      }, TYPING_INTERVAL);
    } catch (err) {
      console.error('[Messenger] Failed to start typing:', err);
    }
  }

  stopTyping(): void {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
  }

  // --- Status throttling (shared logic) ---

  private lastStatus = '';
  private lastStatusChangeTime = 0;
  private statusUpdateTimeout: NodeJS.Timeout | null = null;

  setStatus(text: string): void {
    if (this.statusUpdateTimeout) {
      clearTimeout(this.statusUpdateTimeout);
      this.statusUpdateTimeout = null;
    }

    const now = Date.now();
    const timeSinceLastChange = now - this.lastStatusChangeTime;

    if (timeSinceLastChange < STATUS_THROTTLE_MS && this.lastStatusChangeTime > 0) {
      this.statusUpdateTimeout = setTimeout(() => {
        this.setStatus(text);
        this.statusUpdateTimeout = null;
      }, STATUS_THROTTLE_MS - timeSinceLastChange);
    } else if (text !== this.lastStatus) {
      this.applyStatus(text);
      this.lastStatus = text;
      this.lastStatusChangeTime = Date.now();
    }
  }

  clearStatus(): void {
    this.setStatus('');
  }

  setIdle(): void {
    if (this.statusUpdateTimeout) {
      clearTimeout(this.statusUpdateTimeout);
      this.statusUpdateTimeout = null;
    }
    this.lastStatus = '';
    this.applyIdle();
  }

  // --- Message splitting (shared logic) ---

  splitMessage(content: string, maxLength = MESSAGE_MAX_LENGTH): string[] {
    if (content.length <= maxLength) return [content];

    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      let splitIndex = remaining.lastIndexOf('\n', maxLength);
      if (splitIndex <= 0) {
        splitIndex = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitIndex <= 0) {
        splitIndex = maxLength;
      }

      chunks.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex).trimStart();
    }

    return chunks;
  }
}
