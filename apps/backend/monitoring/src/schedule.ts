/**
 * On-call schedule management
 * Issue #157
 */

import { createLogger } from "@delegolabs/utils";
import type { OnCallSchedule, HandoffRecord } from "@delegolabs/types";

const log = createLogger("monitoring:schedule", process.env.LOG_LEVEL ?? "info");

const schedules = new Map<string, OnCallSchedule>();
const handoffs = new Map<string, HandoffRecord[]>();

export function createSchedule(schedule: OnCallSchedule): OnCallSchedule {
  schedules.set(schedule.id, schedule);
  log.info("Schedule created", { id: schedule.id, name: schedule.name, team: schedule.team });
  return schedule;
}

export function getSchedule(id: string): OnCallSchedule | null {
  return schedules.get(id) ?? null;
}

export function listSchedules(): OnCallSchedule[] {
  return Array.from(schedules.values());
}

export function updateSchedule(id: string, updates: Partial<OnCallSchedule>): OnCallSchedule | null {
  const existing = schedules.get(id);
  if (!existing) return null;

  const updated = { ...existing, ...updates, id };
  schedules.set(id, updated);
  log.info("Schedule updated", { id });
  return updated;
}

export function deleteSchedule(id: string): boolean {
  const deleted = schedules.delete(id);
  if (deleted) log.info("Schedule deleted", { id });
  return deleted;
}

export function getCurrentOnCall(scheduleId: string): { userId: string; role: string } | null {
  const schedule = schedules.get(scheduleId);
  if (!schedule) return null;

  const now = new Date();

  for (const override of schedule.overrides) {
    const start = new Date(override.start);
    const end = new Date(override.end);
    if (now >= start && now <= end) {
      return { userId: override.userId, role: "primary" };
    }
  }

  for (const rotation of schedule.rotations) {
    const start = new Date(rotation.start);
    const end = new Date(rotation.end);
    if (now >= start && now <= end) {
      return { userId: rotation.userId, role: rotation.role };
    }
  }

  return null;
}

export function getOnCallUsers(scheduleId: string, date?: Date): Array<{ userId: string; role: string; start: string; end: string }> {
  const schedule = schedules.get(scheduleId);
  if (!schedule) return [];

  const targetDate = date ?? new Date();
  const results: Array<{ userId: string; role: string; start: string; end: string }> = [];

  for (const rotation of schedule.rotations) {
    const start = new Date(rotation.start);
    const end = new Date(rotation.end);
    if (targetDate >= start && targetDate <= end) {
      results.push({
        userId: rotation.userId,
        role: rotation.role,
        start: rotation.start,
        end: rotation.end,
      });
    }
  }

  return results;
}

export function addOverride(
  scheduleId: string,
  override: { userId: string; start: string; end: string; reason: string }
): boolean {
  const schedule = schedules.get(scheduleId);
  if (!schedule) return false;

  schedule.overrides.push(override);
  log.info("Override added", { scheduleId, userId: override.userId });
  return true;
}

export function removeOverride(scheduleId: string, userId: string, start: string): boolean {
  const schedule = schedules.get(scheduleId);
  if (!schedule) return false;

  const initialLength = schedule.overrides.length;
  schedule.overrides = schedule.overrides.filter(
    (o) => !(o.userId === userId && o.start === start)
  );

  const removed = schedule.overrides.length < initialLength;
  if (removed) log.info("Override removed", { scheduleId, userId });
  return removed;
}

export function createHandoff(
  scheduleId: string,
  fromUserId: string,
  toUserId: string,
  notes?: string
): HandoffRecord {
  const handoff: HandoffRecord = {
    id: `handoff_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    scheduleId,
    fromUserId,
    toUserId,
    handoffAt: new Date().toISOString(),
    acknowledged: false,
    notes,
  };

  const existing = handoffs.get(scheduleId) ?? [];
  existing.push(handoff);
  handoffs.set(scheduleId, existing);

  log.info("Handoff created", { scheduleId, fromUserId, toUserId });
  return handoff;
}

export function acknowledgeHandoff(handoffId: string, scheduleId: string): boolean {
  const existing = handoffs.get(scheduleId) ?? [];
  const handoff = existing.find((h) => h.id === handoffId);
  if (!handoff) return false;

  handoff.acknowledged = true;
  log.info("Handoff acknowledged", { handoffId, scheduleId });
  return true;
}

export function getHandoffs(scheduleId: string): HandoffRecord[] {
  return handoffs.get(scheduleId) ?? [];
}

export function getTeamSchedules(team: string): OnCallSchedule[] {
  return Array.from(schedules.values()).filter((s) => s.team === team);
}
