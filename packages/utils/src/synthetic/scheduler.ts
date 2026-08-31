/**
 * Check Scheduler - Schedules synthetic checks at regular intervals
 */

import { createLogger } from "../logger.js";
import type { SyntheticCheck, Schedule } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Check Scheduler
// ─────────────────────────────────────────────────────────────────────────────

export class CheckScheduler {
  private checks = new Map<string, SyntheticCheck>();
  private schedules = new Map<string, Schedule>();
  private runningTasks = new Map<string, NodeJS.Timeout | number>();
  private defaultFrequency = 60; // 1 minute

  constructor() {
    this.setupDefaultSchedule();
  }

  private setupDefaultSchedule(): void {
    // Default hourly schedule
    this.addSchedule({
      id: "default-hourly",
      name: "Default Hourly Schedule",
      cron: "0 * * * *", // Every hour
      checks: [],
      timezone: "UTC",
    });

    // Default minute schedule
    this.addSchedule({
      id: "default-minute",
      name: "Default Minute Schedule",
      cron: "* * * * *", // Every minute
      checks: [],
      timezone: "UTC",
    });
  }

  // ─── Schedule Management ────────────────────────────────────────────────

  addSchedule(schedule: Schedule): void {
    this.schedules.set(schedule.id, schedule);
    log.info("Schedule added", { id: schedule.id, cron: schedule.cron });
  }

  updateSchedule(id: string, updates: Partial<Schedule>): boolean {
    const existing = this.schedules.get(id);
    if (!existing) return false;

    const updated = { ...existing, ...updates, id };
    this.schedules.set(id, updated);
    return true;
  }

  removeSchedule(id: string): boolean {
    return this.schedules.delete(id);
  }

  listSchedules(): Schedule[] {
    return Array.from(this.schedules.values());
  }

  // ─── Check Management ───────────────────────────────────────────────────

  addCheckToSchedule(scheduleId: string, checkId: string): boolean {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) return false;

    schedule.checks.push(checkId);
    return true;
  }

  removeCheckFromSchedule(scheduleId: string, checkId: string): boolean {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) return false;

    const index = schedule.checks.indexOf(checkId);
    if (index > -1) {
      schedule.checks.splice(index, 1);
      return true;
    }
    return false;
  }

  // ─── Scheduling ─────────────────────────────────────────────────────────

  async startSchedule(scheduleId: string, executeCheck: (checkId: string) => Promise<void>): Promise<void> {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }

    // Parse cron expression
    const cronExpression = schedule.cron;
    const frequency = this.getCronFrequency(cronExpression) || this.defaultFrequency;

    log.info("Starting schedule", { id: scheduleId, frequency });

    // Clear existing task
    if (this.runningTasks.has(scheduleId)) {
      this.stopSchedule(scheduleId);
    }

    // Create new task
    const task = setInterval(async () => {
      await this.executeSchedule(scheduleId, executeCheck);
    }, frequency * 1000);

    this.runningTasks.set(scheduleId, task);
  }

  async stopSchedule(scheduleId: string): Promise<void> {
    const task = this.runningTasks.get(scheduleId);
    if (task) {
      clearInterval(task);
      this.runningTasks.delete(scheduleId);
      log.info("Schedule stopped", { id: scheduleId });
    }
  }

  async executeSchedule(scheduleId: string, executeCheck: (checkId: string) => Promise<void>): Promise<void> {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) return;

    log.info("Executing schedule", { id: scheduleId, checks: schedule.checks.length });

    // Execute all checks in this schedule
    for (const checkId of schedule.checks) {
      try {
        await executeCheck(checkId);
      } catch (err) {
        log.error("Check execution failed", {
          checkId,
          error: (err as Error).message,
        });
      }
    }
  }

  // ─── Helper Methods ─────────────────────────────────────────────────────

  private getCronFrequency(cron: string): number | null {
    // Parse simple cron expressions
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return null;

    const [minute, hour, day, month, weekday] = parts;

    // Check for common patterns
    if (minute === "*" && hour === "*" && day === "*" && month === "*" && weekday === "*") {
      return 60; // Every minute
    }
    if (hour === "*" && day === "*" && month === "*" && weekday === "*") {
      return 60 * 60; // Every hour
    }
    if (day === "*" && month === "*" && weekday === "*") {
      return 24 * 60 * 60; // Every day
    }

    // Calculate based on minute interval
    if (minute.includes("/")) {
      const interval = parseInt(minute.split("/")[1], 10);
      return interval * 60;
    }

    return null;
  }

  // ─── Utility Methods ────────────────────────────────────────────────────

  getSchedulesForCheck(checkId: string): string[] {
    const schedules: string[] = [];
    
    for (const [id, schedule] of this.schedules) {
      if (schedule.checks.includes(checkId)) {
        schedules.push(id);
      }
    }

    return schedules;
  }

  getActiveTasks(): string[] {
    return Array.from(this.runningTasks.keys());
  }

  stopAll(): void {
    for (const [id] of this.runningTasks) {
      this.stopSchedule(id);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron Expression Helper
// ─────────────────────────────────────────────────────────────────────────────

export interface CronExpression {
  minute: string;
  hour: string;
  day: string;
  month: string;
  weekday: string;
}

export function parseCron(cron: string): CronExpression | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  return {
    minute: parts[0],
    hour: parts[1],
    day: parts[2],
    month: parts[3],
    weekday: parts[4],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

const log = createLogger("utils:synthetic-scheduler", process.env.LOG_LEVEL ?? "info");