/**
 * @delegolabs/orchestrator — Task analytics
 *
 * Computes cycle time, throughput and SLA breach rate over a period, broken down by
 * assignee and by task type, using the shared `TaskMetrics` shape.
 */

import type { TaskMetrics } from "@delegolabs/types";
import type { HumanTask, TaskStore } from "./types.js";

function hoursBetween(startIso: string, endIso: string): number {
  return (new Date(endIso).getTime() - new Date(startIso).getTime()) / 3600_000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Builds `TaskMetrics` for `[start, end]`. Cycle time is measured from `createdAt`
 * to `completedAt` for tasks completed within the window. SLA breach rate is the
 * share of tasks completed (or escalated/expired) within the window whose due date
 * passed at or before completion.
 */
export async function computeTaskMetrics(
  store: TaskStore,
  period: { start: Date; end: Date }
): Promise<TaskMetrics> {
  const completed = await store.listCompletedBetween(period.start, period.end);
  const created = await store.listCreatedBetween(period.start, period.end);

  const totalTasks = created.length;
  const completedTasks = completed.length;

  const cycleTimes: number[] = [];
  const breached: HumanTask[] = [];
  for (const task of completed) {
    if (task.createdAt && task.completedAt) {
      cycleTimes.push(hoursBetween(task.createdAt, task.completedAt));
    }
    if (task.completedAt && new Date(task.dueAt).getTime() < new Date(task.completedAt).getTime()) {
      breached.push(task);
    }
  }
  // Escalated/expired tasks also count as SLA breaches regardless of completion time.
  for (const task of completed) {
    if (task.status === "escalated" || task.status === "expired") breached.push(task);
  }

  const avgCycleTimeHours = cycleTimes.length
    ? round2(cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length)
    : 0;

  const slaBreachRate = completedTasks ? round2(breached.length / completedTasks) : 0;

  const byAssignee: Record<string, { assigned: number; completed: number; avgTimeHours: number }> = {};
  const byType: Record<string, { count: number; avgTimeHours: number }> = {};

  const typeTimes: Record<string, number[]> = {};
  for (const task of created) {
    if (task.assignee) {
      byAssignee[task.assignee] = byAssignee[task.assignee] ?? { assigned: 0, completed: 0, avgTimeHours: 0 };
      byAssignee[task.assignee].assigned += 1;
    }
    byType[task.type] = byType[task.type] ?? { count: 0, avgTimeHours: 0 };
    byType[task.type].count += 1;
  }
  const assigneeTimes: Record<string, number[]> = {};
  for (const task of completed) {
    const key = task.assignee ?? "unassigned";
    byAssignee[key] = byAssignee[key] ?? { assigned: 0, completed: 0, avgTimeHours: 0 };
    byAssignee[key].completed += 1;
    if (task.createdAt && task.completedAt) {
      (assigneeTimes[key] = assigneeTimes[key] ?? []).push(hoursBetween(task.createdAt, task.completedAt));
    }
    if (task.type in byType) {
      if (task.createdAt && task.completedAt) {
        (typeTimes[task.type] = typeTimes[task.type] ?? []).push(hoursBetween(task.createdAt, task.completedAt));
      }
    } else {
      byType[task.type] = byType[task.type] ?? { count: 0, avgTimeHours: 0 };
      if (task.createdAt && task.completedAt) {
        (typeTimes[task.type] = typeTimes[task.type] ?? []).push(hoursBetween(task.createdAt, task.completedAt));
      }
    }
  }

  for (const key of Object.keys(byAssignee)) {
    const times = assigneeTimes[key] ?? [];
    byAssignee[key].avgTimeHours = times.length ? round2(times.reduce((a, b) => a + b, 0) / times.length) : 0;
  }
  for (const key of Object.keys(byType)) {
    const times = typeTimes[key] ?? [];
    byType[key].avgTimeHours = times.length ? round2(times.reduce((a, b) => a + b, 0) / times.length) : 0;
  }

  return {
    period: { start: period.start.toISOString(), end: period.end.toISOString() },
    totalTasks,
    completedTasks,
    avgCycleTimeHours,
    slaBreachRate,
    byAssignee,
    byType,
  };
}
