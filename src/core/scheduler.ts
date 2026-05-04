import cron from 'node-cron';
import fs from 'fs';
import { logger } from './logger.js';

export interface ScheduleEntry {
  id: string;
  cron: string;
  channelId: string;
  guildId?: string;
  prompt: string;
  description?: string;
  enabled: boolean;
}

type ScheduleFireCallback = (entry: ScheduleEntry) => Promise<void>;

export class Scheduler {
  private entries = new Map<string, ScheduleEntry>();
  private tasks = new Map<string, cron.ScheduledTask>();
  private callback: ScheduleFireCallback;
  private filePath: string;
  private timezone: string;
  private watching = false;
  private lastSavedAt = 0;

  constructor(filePath: string, callback: ScheduleFireCallback, timezone = 'Asia/Tokyo') {
    this.filePath = filePath;
    this.callback = callback;
    this.timezone = timezone;
  }

  /** Load saved schedules from disk and start enabled ones. */
  restore(): void {
    this.reloadFromDisk();
    this.startWatching();
  }

  private reloadFromDisk(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.applyEntries([]);
        return;
      }

      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as ScheduleEntry[];
      this.applyEntries(data);
      logger.log(`[Scheduler] Restored ${data.length} schedule(s) (${this.tasks.size} active)`);
    } catch (err) {
      logger.error('[Scheduler] Failed to restore schedules:', err);
    }
  }

  /**
   * Apply a desired set of entries with minimal disruption: only restart cron
   * tasks whose definition actually changed. Removed entries are stopped, new
   * ones are started, and unchanged ones keep running uninterrupted.
   */
  private applyEntries(desired: ScheduleEntry[]): void {
    const desiredById = new Map(desired.map(e => [e.id, e]));

    for (const id of [...this.entries.keys()]) {
      if (!desiredById.has(id)) {
        this.stopTask(id);
        this.entries.delete(id);
      }
    }

    for (const entry of desired) {
      const previous = this.entries.get(entry.id);
      const taskDirty = !previous
        || previous.cron !== entry.cron
        || previous.enabled !== entry.enabled;

      this.entries.set(entry.id, entry);

      if (!taskDirty) continue;

      if (entry.enabled) {
        if (!cron.validate(entry.cron)) {
          logger.error(`[Scheduler] Skipping entry "${entry.id}" with invalid cron: ${entry.cron}`);
          this.stopTask(entry.id);
          continue;
        }
        try {
          this.startTask(entry);
        } catch (err) {
          logger.error(`[Scheduler] Failed to start task "${entry.id}":`, err);
          this.stopTask(entry.id);
        }
      } else {
        this.stopTask(entry.id);
      }
    }
  }

  /** Add a new schedule entry. */
  add(entry: Omit<ScheduleEntry, 'id' | 'enabled'> & { id?: string; enabled?: boolean }): ScheduleEntry {
    if (!cron.validate(entry.cron)) {
      throw new Error(`Invalid cron expression: ${entry.cron}`);
    }

    const id = entry.id ?? this.generateId();
    const full: ScheduleEntry = {
      id,
      cron: entry.cron,
      channelId: entry.channelId,
      guildId: entry.guildId,
      prompt: entry.prompt,
      description: entry.description,
      enabled: entry.enabled ?? true,
    };

    this.entries.set(id, full);
    if (full.enabled) {
      this.startTask(full);
    }
    this.save();
    logger.log(`[Scheduler] Added schedule "${id}": ${full.cron} → ch:${full.channelId}`);
    return full;
  }

  /** Remove a schedule by ID. */
  remove(id: string): boolean {
    const existed = this.entries.delete(id);
    if (existed) {
      this.stopTask(id);
      this.save();
      logger.log(`[Scheduler] Removed schedule "${id}"`);
    }
    return existed;
  }

  /** List all schedule entries. */
  list(): ScheduleEntry[] {
    return [...this.entries.values()];
  }

  /** Stop all cron tasks. */
  stop(): void {
    for (const [id, task] of this.tasks) {
      task.stop();
      logger.log(`[Scheduler] Stopped task "${id}"`);
    }
    this.tasks.clear();
  }

  /** Stop tasks and release the file watcher. Use on shutdown. */
  dispose(): void {
    this.stop();
    if (this.watching) {
      fs.unwatchFile(this.filePath);
      this.watching = false;
    }
  }

  private startWatching(): void {
    if (this.watching) return;
    this.watching = true;

    fs.watchFile(this.filePath, { interval: 1000 }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs) return;
      if (Date.now() - this.lastSavedAt < 500) return;
      logger.log('[Scheduler] Detected external schedule file change, reloading');
      this.reloadFromDisk();
    });
  }

  private startTask(entry: ScheduleEntry): void {
    this.stopTask(entry.id);
    const task = cron.schedule(entry.cron, async () => {
      logger.log(`[Scheduler] Firing "${entry.id}": ${entry.prompt.slice(0, 80)}`);
      try {
        await this.callback(entry);
      } catch (err) {
        logger.error(`[Scheduler] Error firing "${entry.id}":`, err);
      }
    }, { timezone: this.timezone });
    this.tasks.set(entry.id, task);
  }

  private stopTask(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      this.tasks.delete(id);
    }
  }

  private save(): void {
    try {
      const data = [...this.entries.values()];
      this.lastSavedAt = Date.now();
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      logger.error('[Scheduler] Failed to save schedules:', err);
    }
  }

  private generateId(): string {
    return `sched_${Date.now().toString(36)}`;
  }
}
