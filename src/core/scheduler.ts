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

  constructor(filePath: string, callback: ScheduleFireCallback, timezone = 'Asia/Tokyo') {
    this.filePath = filePath;
    this.callback = callback;
    this.timezone = timezone;
  }

  /** Load saved schedules from disk and start enabled ones. */
  restore(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as ScheduleEntry[];
      for (const entry of data) {
        this.entries.set(entry.id, entry);
        if (entry.enabled) {
          this.startTask(entry);
        }
      }
      logger.log(`[Scheduler] Restored ${data.length} schedule(s) (${this.tasks.size} active)`);
    } catch (err) {
      logger.error('[Scheduler] Failed to restore schedules:', err);
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

  /** Toggle a schedule's enabled state. */
  toggle(id: string): ScheduleEntry | null {
    const entry = this.entries.get(id);
    if (!entry) return null;

    entry.enabled = !entry.enabled;
    if (entry.enabled) {
      this.startTask(entry);
    } else {
      this.stopTask(id);
    }
    this.save();
    logger.log(`[Scheduler] Toggled "${id}" → ${entry.enabled ? 'enabled' : 'disabled'}`);
    return entry;
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
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      logger.error('[Scheduler] Failed to save schedules:', err);
    }
  }

  private generateId(): string {
    return `sched_${Date.now().toString(36)}`;
  }
}
