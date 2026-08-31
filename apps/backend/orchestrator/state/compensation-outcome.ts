// Issue #35 — Persists the final outcome of a workflow's escrow compensation run

import type { CompensationStatus } from "../workflows/purchase/compensation.js";

export interface CompensationOutcomeRecord {
  workflowId: string;
  status: CompensationStatus | "escrow_stuck";
  compensatedSteps: string[];
  failedSteps: Array<{ step: string; error: string }>;
  cause: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertCompensationOutcomeInput {
  workflowId: string;
  status: CompensationStatus | "escrow_stuck";
  compensatedSteps: string[];
  failedSteps: Array<{ step: string; error: string }>;
  cause: string | null;
}

export interface CompensationOutcomeStore {
  upsert(input: UpsertCompensationOutcomeInput): Promise<CompensationOutcomeRecord>;
  get(workflowId: string): Promise<CompensationOutcomeRecord | null>;
}

class InMemoryCompensationOutcomeStore implements CompensationOutcomeStore {
  private readonly rows = new Map<string, CompensationOutcomeRecord>();

  async upsert(input: UpsertCompensationOutcomeInput): Promise<CompensationOutcomeRecord> {
    const now = new Date().toISOString();
    const existing = this.rows.get(input.workflowId);
    const record: CompensationOutcomeRecord = {
      workflowId: input.workflowId,
      status: input.status,
      compensatedSteps: input.compensatedSteps,
      failedSteps: input.failedSteps,
      cause: input.cause,
      attempts: (existing?.attempts ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(input.workflowId, record);
    return record;
  }

  async get(workflowId: string): Promise<CompensationOutcomeRecord | null> {
    return this.rows.get(workflowId) ?? null;
  }

  /** Test helper. */
  snapshot(): readonly CompensationOutcomeRecord[] {
    return [...this.rows.values()];
  }

  clear(): void {
    this.rows.clear();
  }
}

let outcomeStore: CompensationOutcomeStore = new InMemoryCompensationOutcomeStore();

/** Swap for a Postgres implementation backed by workflow_compensation_outcomes. */
export function setCompensationOutcomeStore(store: CompensationOutcomeStore): void {
  outcomeStore = store;
}

export function resetCompensationOutcomeStore(): void {
  outcomeStore = new InMemoryCompensationOutcomeStore();
}

/**
 * Records the outcome of a compensation run on the workflow record, so operators
 * (and the reconciliation/timeout paths) can see the latest compensation result
 * without replaying the full audit trail. Upserts by workflowId — a retried
 * compensation run (e.g. after a transient step failure) overwrites the prior
 * outcome with the latest attempt and increments `attempts`.
 *
 * Backed by `workflow_compensation_outcomes`
 * (see database/migrations/020_workflow_compensation_outcomes.sql).
 */
export async function upsertCompensationOutcome(
  input: UpsertCompensationOutcomeInput
): Promise<CompensationOutcomeRecord> {
  if (!input.workflowId || input.workflowId.trim() === "") {
    throw new Error("workflowId is required");
  }
  return outcomeStore.upsert(input);
}

export async function getCompensationOutcome(workflowId: string): Promise<CompensationOutcomeRecord | null> {
  return outcomeStore.get(workflowId);
}
