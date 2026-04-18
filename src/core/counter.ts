import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

export interface RequestCounts {
  sendAndWait: Record<string, number>; // model -> count
  waitMessages: number;
  sendMessage: number;
}

const DEFAULT_COUNTS: RequestCounts = {
  sendAndWait: {},
  waitMessages: 0,
  sendMessage: 0,
};

export class RequestCounter {
  private counts: RequestCounts;
  private filePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dir: string) {
    this.filePath = path.join(dir, 'request_counts.json');
    this.counts = this.load();
  }

  private load(): RequestCounts {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        return {
          sendAndWait: data.sendAndWait ?? {},
          waitMessages: data.waitMessages ?? 0,
          sendMessage: data.sendMessage ?? 0,
        };
      }
    } catch (err) {
      logger.error('[COUNTER] Failed to load counts:', err);
    }
    return { ...DEFAULT_COUNTS, sendAndWait: {} };
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveSync();
    }, 1000);
  }

  private saveSync(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.counts, null, 2));
    } catch (err) {
      logger.error('[COUNTER] Failed to save counts:', err);
    }
  }

  incrementSendAndWait(model: string): void {
    this.counts.sendAndWait[model] = (this.counts.sendAndWait[model] || 0) + 1;
    this.scheduleSave();
  }

  incrementWaitMessages(): void {
    this.counts.waitMessages++;
    this.scheduleSave();
  }

  incrementSendMessage(): void {
    this.counts.sendMessage++;
    this.scheduleSave();
  }

  getCounts(): RequestCounts {
    return { ...this.counts, sendAndWait: { ...this.counts.sendAndWait } };
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveSync();
  }
}
