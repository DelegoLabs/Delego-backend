/**
 * @delegolabs/orchestrator — SLA tracking and escalation
 *
 * Monitors open human tasks against their SLA `dueAt` and escalates or expires
 * them:
 *
 * - A task past its due date with status still open and not yet escalated is marked
 *   `escalated` (its assignee has one more chance within `graceHours`, default 24).
 * - A task still open after the escalation grace period expires is marked `expired`.
 *
 * `scanAndEscalate()` is the idempotent sweep invoked on a timer (or from a
 * scheduler) and returns the set of task ids whose status changed.
 */

import { createLogger } from "@delegolabs/utils";
import type { HumanTask, HumanTaskStatus, TaskStore } from "./types.js";

const log = createLogger("orchestrator:tasks:sla", process.env.LOG_LEVEL ?? "info");

export interface SlaScanResult {
  escalated: string[];
  expired: string[];
  checked: number;
}

function followUpDeadline(task: HumanTask, graceHours: number): Date {
  const due = new Date(task.dueAt).getTime();
  if (task.status === "escalated") {
    // expires `graceHours` after escalation occurred (last update).
    const lastUpdate = task.completedAt ?? task.claimedAt ?? task.assignedAt ?? task.createdAt;
    const base = lastUpdate ? new Date(lastUpdate).getTime() : due;
    return new Date(Math.max(base, due) + graceHours * 3600_000);
  }
  return new Date(due);
}

const OPEN_STATUSES: HumanTaskStatus[] = ["created", "assigned", "claimed", "in_progress"];

/**
 * Runs a single SLA scan over all open tasks. Idempotent: a task is only mutated
 * when its transition is due, so calling repeatedly is safe. Returns the ids whose
 * status changed.
 */
export async function scanSla(
  store: TaskStore,
  options: { graceHours?: number; now?: Date } = {}
): Promise<SlaScanResult> {
  const graceHours = options.graceHours ?? 24;
  const now = options.now ?? new Date();
  const tasks = await store.listForSlaScan(now);
  const escalated: string[] = [];
  const expired: string[] = [];

  for (const task of tasks) {
    if (!OPEN_STATUSES.includes(task.status) && task.status !== "escalated") continue;
    const deadline = followUpDeadline(task, graceHours);
    if (now.getTime() <= deadline.getTime()) continue;

    if (task.status === "escalated") {
      task.status = "expired";
      task.completedAt = now.toISOString();
      await store.update(task);
      expired.push(task.id);
      log.warn("Human task expired after SLA escalation grace period", {
        taskId: task.id,
        assignee: task.assignee,
      });
    } else {
      task.status = "escalated";
      task.completedAt = undefined;
      await store.update(task);
      escalated.push(task.id);
      log.warn("Human task breached SLA, escalated", {
        taskId: task.id,
        assignee: task.assignee,
        dueAt: task.dueAt,
      });
    }
  }

  return { escalated, expired, checked: tasks.length };
}

/**
 * Returns the SLA status for a single task at the given time:
 * `"ok"` when within SLA, `"at_risk"` within the warning window (default 2h before
 * due), `"breached"` after the due date while still open, or `"met"` once complete.
 */
export function slaStatus(task: HumanTask, now: Date = new Date(), warningHours = 2): "ok" | "at_risk" | "breached" | "met" {
  if (task.status === "completed" || task.status === "rejected" || task.status === "expired") {
    return "met";
  }
  if (task.status === "escalated") return "breached";
  const remainingMs = new Date(task.dueAt).getTime() - now.getTime();
  if (remainingMs < 0) return "breached";
  if (remainingMs <= warningHours * 3600_000) return "at_risk";
  return "ok";
}
