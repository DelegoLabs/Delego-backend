import { randomUUID } from "node:crypto";
import { workflowLockKey, stepLockKey } from "@delegolabs/cache";

export function resolveOrchestratorInstanceId(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ORCHESTRATOR_INSTANCE_ID && env.ORCHESTRATOR_INSTANCE_ID.trim() !== "") {
    return env.ORCHESTRATOR_INSTANCE_ID.trim();
  }
  const host = env.HOSTNAME ?? "orchestrator";
  return `${host}:${process.pid}:${randomUUID()}`;
}

export function lockKeyForWorkflow(workflowId: string): string {
  return workflowLockKey(workflowId);
}

export function lockKeyForStep(workflowId: string, stepName: string): string {
  return stepLockKey(workflowId, stepName);
}

export function lockLevelFromKey(key: string): "workflow" | "step" {
  return key.startsWith("lock:step:") ? "step" : "workflow";
}

export function distributedLocksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENABLE_DISTRIBUTED_LOCKS !== "false";
}

export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}
