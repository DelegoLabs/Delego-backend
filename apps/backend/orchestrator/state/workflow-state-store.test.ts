import { describe, expect, it } from "vitest";

import type { WorkflowStateStore } from "./types.js";
import {
  InMemoryWorkflowStateStore,
  PostgresWorkflowStateStore,
} from "../src/saga/index.js";
import { SagaConcurrencyError, type SagaEvent, type SagaRecord } from "../src/saga/types.js";

function makeRecord(overrides: Partial<SagaRecord> = {}): SagaRecord {
  const now = new Date("2026-11-24T00:00:00.000Z");
  return {
    sagaId: "workflow-1",
    orderId: "order-1",
    workflowType: "checkout",
    status: "running",
    currentStep: "reserve",
    completedSteps: [],
    context: { value: 1 },
    version: 0,
    correlationId: "correlation-1",
    error: null,
    expiresAt: null,
    claimExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("WorkflowStateStore implementations", () => {
  it("persists isolated checkpoints, increments versions, and stores audit events in memory", async () => {
    const store: WorkflowStateStore = new InMemoryWorkflowStateStore();
    const created = await store.create(makeRecord());
    created.context.value = 2;

    const stored = await store.get("workflow-1");
    expect(stored?.context.value).toBe(1);

    const saved = await store.save({ ...stored!, status: "completed" });
    expect(saved.version).toBe(1);
    await expect(store.save(stored!)).rejects.toBeInstanceOf(SagaConcurrencyError);

    const event: SagaEvent = {
      sagaId: "workflow-1",
      correlationId: "correlation-1",
      eventType: "workflow_completed",
      fromStatus: "running",
      toStatus: "completed",
      payload: {},
      createdAt: new Date("2026-11-24T00:01:00.000Z"),
    };
    await store.appendEvent(event);
    expect(await store.getEvents("workflow-1")).toEqual([event]);
  });

  it("exposes the PostgreSQL implementation through the unified contract", () => {
    const store: WorkflowStateStore = new PostgresWorkflowStateStore();
    expect(store).toBeInstanceOf(PostgresWorkflowStateStore);
  });
});
