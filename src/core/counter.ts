import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/** Per-request log entry */
export interface RequestLogEntry {
  startedAt: string;
  lastUpdated: string;
  model: string;
  recv: number;
  sent: number;
}

interface PersistedData {
  logs: RequestLogEntry[];
}

const LOG_RETENTION_DAYS = 30;

export class RequestCounter {
  private logs: RequestLogEntry[];
  private currentLog: RequestLogEntry | null = null;
  private filePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dir: string) {
    this.filePath = path.join(dir, 'request_counts.json');
    this.logs = this.load();
  }

  private load(): RequestLogEntry[] {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        // Support both old and new format
        if (Array.isArray(data.logs)) return data.logs;
        if (Array.isArray(data)) return data;
      }
    } catch (err) {
      logger.error('[COUNTER] Failed to load counts:', err);
    }
    return [];
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
      // Include currentLog in saved data for real-time persistence
      const allLogs = this.currentLog ? [...this.logs, this.currentLog] : this.logs;
      const data: PersistedData = { logs: allLogs };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      logger.error('[COUNTER] Failed to save counts:', err);
    }
  }

  /** Start a new request log entry. Call before sendAndWait. */
  startRequest(model: string, receivedCount: number): void {
    if (this.currentLog) {
      this.logs.push(this.currentLog);
    }
    this.currentLog = {
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      model,
      recv: receivedCount,
      sent: 0,
    };
    this.pruneOldLogs();
    this.scheduleSave();
  }

  /** Increment sent count for the current request */
  incrementSendMessage(): void {
    if (this.currentLog) {
      this.currentLog.sent++;
      this.currentLog.lastUpdated = new Date().toISOString();
    }
    this.scheduleSave();
  }

  /** Add received messages to the current request */
  addReceived(count: number): void {
    if (this.currentLog) {
      this.currentLog.recv += count;
      this.currentLog.lastUpdated = new Date().toISOString();
    }
    this.scheduleSave();
  }

  /** Finalize the current request log */
  finalizeRequest(): void {
    if (this.currentLog) {
      this.logs.push(this.currentLog);
      this.currentLog = null;
    }
    this.scheduleSave();
  }

  getLogs(): RequestLogEntry[] {
    const all = [...this.logs];
    if (this.currentLog) all.push(this.currentLog);
    return all;
  }

  /** Get daily aggregation (JST), optionally filtered by model. */
  getDailyStats(days: number = 7): { date: string; requests: number; recv: number; sent: number; models: Record<string, number> }[] {
    const buckets = new Map<string, { requests: number; recv: number; sent: number; models: Record<string, number> }>();

    for (const log of this.getLogs()) {
      const date = toJSTDate(log.startedAt);
      const b = buckets.get(date) ?? { requests: 0, recv: 0, sent: 0, models: {} };
      b.requests++;
      b.recv += log.recv;
      b.sent += log.sent;
      b.models[log.model] = (b.models[log.model] || 0) + 1;
      buckets.set(date, b);
    }

    return Array.from(buckets.entries())
      .map(([date, stats]) => ({ date, ...stats }))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, days);
  }

  /** Get total counts by model */
  getModelTotals(): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const log of this.getLogs()) {
      totals[log.model] = (totals[log.model] || 0) + 1;
    }
    return totals;
  }

  private pruneOldLogs(): void {
    const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    this.logs = this.logs.filter(log => log.startedAt >= cutoff);
  }

  flush(): void {
    if (this.currentLog) {
      this.logs.push(this.currentLog);
      this.currentLog = null;
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveSync();
  }
}

/** Convert ISO timestamp to JST date string (YYYY-MM-DD) */
function toJSTDate(iso: string): string {
  const d = new Date(iso);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}
