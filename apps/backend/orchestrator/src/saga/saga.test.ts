/**
 * Unit tests for Issue #48 — durable saga persistence, event sourcing, crash
 * recovery, timeout detection, and JSONB context validation. Uses the in-memory
 * store so it needs no PostgreSQL.
 */

import { describe, it, expect, vi } from "vitest";
import {
  SagaCoordinator,
  type SagaCoordinatorOptions,
  InMemorySagaStore,
  serializeSagaExecution,
  validateSagaContext,
  SagaContextValidationError,
  type SagaRecord,
  type SagaStep,
} from "./index.js";
import { SagaConcurrencyError } from "./types.js";

type Ctx = Record<string, unknown>;

function makeRecord(overrides: Partial<SagaRecord<Ctx>> = {}): SagaRecord<Ctx> {
  const now = new Date();
  return {
    sagaId: "saga-1",
    orderId: "order-1",
    workflowType: "checkout",
    status: "running",
    currentStep: "a",
    completedSteps: [],
    context: {},
    version: 0,
    correlationId: "corr-1",
    error: null,
    expiresAt: null,
    claimExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeCoordinator(
  steps: Array<SagaStep<Ctx>>,
  store: InMemorySagaStore,
  options: Partial<SagaCoordinatorOptions<Ctx>> = {}
): SagaCoordinator<Ctx> {
  return new SagaCoordinator<Ctx>({ steps, store, ...options });
}

describe("optimistic locking", () => {
  it("bumps version on save and rejects stale writes", async () => {
    const store = new InMemorySagaStore();
    const created = await store.create(makeRecord());
    expect(created.version).toBe(0);

    const saved = await store.save({ ...created, status: "completed" });
    expect(saved.version).toBe(1);

    // A second save using the stale (version 0) snapshot must be rejected so two
    // runners can never both win the same step claim (exactly-once semantics).
    await expect(store.save({ ...created, status: "failed" })).rejects.toBeInstanceOf(SagaConcurrencyError);
  });

  it("create is idempotent for an existing sagaId", async () => {
    const store = new InMemorySagaStore();
    const first = await store.create(makeRecord({ sagaId: "dup" }));
    const second = await store.create(makeRecord({ sagaId: "dup", status: "failed" }));
    expect(second.status).toBe(first.status);
    expect(second.version).toBe(0);
  });
});

describe("saga execution and event sourcing", () => {
  it("executes steps, records rich completedSteps, and appends audit events", async () => {
    const store = new InMemorySagaStore();
    const coordinator = makeCoordinator(
      [
        {
          name: "a",
          execute: async (c) => ({ ...c, a: 1 }),
          compensate: async (c) => ({ ...c, a: 0 }),
        },
        {
          name: "b",
          execute: async (c) => ({ ...c, b: 2 }),
          compensate: async (c) => ({ ...c, b: 0 }),
        },
      ],
      store
    );

    const result = await coordinator.run("exec-1", "order-exec", {});
    expect(result.status).toBe("completed");
    expect(result.completedSteps).toHaveLength(2);
    for (const step of result.completedSteps) {
      expect(step.status).toBe("completed");
      expect(step.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(step.compensationAction).toBe(step.stepName);
      expect(step.output).toBeDefined();
    }

    const events = await store.getEvents("exec-1");
    const types = events.map((e) => e.eventType);
    expect(types).toContain("saga_started");
    expect(types).toContain("step_completed");
    expect(types).toContain("saga_completed");
    // Events are returned in append order.
    expect(events[0].eventType).toBe("saga_started");
  });

  it("compensates completed steps in reverse on failure and records the audit trail", async () => {
    const store = new InMemorySagaStore();
    const compensateA = vi.fn(async (c: Ctx) => ({ ...c, a: 0 }));
    const coordinator = makeCoordinator(
      [
        { name: "a", execute: async (c) => ({ ...c, a: 1 }), compensate: compensateA },
        { name: "b", execute: async () => { throw new Error("boom"); }, compensate: async (c) => ({ ...c, b: 0 }) },
      ],
      store
    );

    const result = await coordinator.run("fail-1", "order-fail", {});
    expect(result.status).toBe("compensated");
    expect(compensateA).toHaveBeenCalledOnce();
    expect(result.completedSteps[0].status).toBe("compensated");

    const events = await store.getEvents("fail-1");
    expect(events.map((e) => e.eventType)).toContain("saga_compensated");
    expect(events.map((e) => e.eventType)).toContain("step_failed");
  });

  it("retries a step per its retry policy before compensating", async () => {
    const store = new InMemorySagaStore();
    let attempts = 0;
    const coordinator = makeCoordinator(
      [
        {
          name: "flaky",
          execute: async (c) => {
            attempts++;
            if (attempts < 3) throw new Error("transient network error");
            return { ...c, ok: true };
          },
          compensate: async (c) => c,
          retryPolicy: { maxAttempts: 3, backoffMs: 1, retryableErrors: ["transient"] },
        },
      ],
      store
    );

    const result = await coordinator.run("retry-1", "order-retry", {});
    expect(result.status).toBe("completed");
    expect(attempts).toBe(3);
  });
});

describe("correlation ids for distributed tracing", () => {
  it("assigns a correlation id and can be looked up by it", async () => {
    const store = new InMemorySagaStore();
    const coordinator = makeCoordinator(
      [{ name: "a", execute: async (c) => c, compensate: async (c) => c }],
      store
    );
    const result = await coordinator.run("corr-1", "order-corr", {}, { correlationId: "trace-xyz" });
    expect(result.correlationId).toBe("trace-xyz");

    const found = await store.findByCorrelationId("trace-xyz");
    expect(found?.sagaId).toBe("corr-1");

    const serialized = serializeSagaExecution(result);
    expect(serialized.correlationId).toBe("trace-xyz");
    expect(typeof serialized.createdAt).toBe("string");
  });
});

describe("crash recovery and timeout detection", () => {
  it("recoverAll auto-compensates a saga that exceeded its deadline", async () => {
    const store = new InMemorySagaStore();
    // A saga left running with an already-past expiry — exactly what a crash would leave behind.
    await store.create(
      makeRecord({
        sagaId: "timed-out-1",
        status: "running",
        currentStep: "a",
        expiresAt: new Date(Date.now() - 1000),
        completedSteps: [{ stepName: "a", status: "completed", output: {}, completedAt: new Date().toISOString() }],
      })
    );

    const coordinator = makeCoordinator(
      [
        { name: "a", execute: async (c) => c, compensate: async (c) => c },
        { name: "b", execute: async (c) => c, compensate: async (c) => c },
      ],
      store,
      { sagaTimeoutMs: 5 * 60 * 1000 }
    );

    const result = await coordinator.recoverAll();
    expect(result.recovered).toBe(1);
    expect(result.details[0].action).toBe("compensated");
    expect(result.details[0].reason).toMatch(/timeout/);

    const after = await store.get("timed-out-1");
    expect(after?.status).toBe("compensated");
    expect(after?.completedSteps.find((s) => s.stepName === "a")?.status).toBe("compensated");
  });

  it("recoverAll resumes a healthy incomplete saga", async () => {
    const store = new InMemorySagaStore();
    await store.create(
      makeRecord({
        sagaId: "healthy-1",
        status: "running",
        currentStep: "b",
        completedSteps: [{ stepName: "a", status: "completed", output: {}, completedAt: new Date().toISOString() }],
      })
    );
    const coordinator = makeCoordinator(
      [
        { name: "a", execute: async (c) => c, compensate: async (c) => c },
        { name: "b", execute: async (c) => c, compensate: async (c) => c },
      ],
      store
    );

    const result = await coordinator.recoverAll();
    expect(result.recovered).toBe(1);
    expect(result.details[0].action).toBe("resumed");
    expect((await store.get("healthy-1"))?.status).toBe("completed");
  });

  it("the timeout sweeper heals a timed-out saga while the service runs", async () => {
    const store = new InMemorySagaStore();
    await store.create(
      makeRecord({
        sagaId: "sweeper-1",
        status: "running",
        currentStep: "a",
        expiresAt: new Date(Date.now() - 1000),
      })
    );
    const coordinator = makeCoordinator(
      [{ name: "a", execute: async (c) => c, compensate: async (c) => c }],
      store,
      { sagaTimeoutMs: 5 * 60 * 1000 }
    );

    const sweeper = coordinator.startTimeoutSweeper(20);
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
    } finally {
      sweeper.stop();
    }
    expect((await store.get("sweeper-1"))?.status).toBe("compensated");
  });
});

describe("JSONB context schema validation", () => {
  const schema = {
    type: "object" as const,
    required: ["orderId"],
    properties: { orderId: { type: "string" as const } },
    additionalProperties: false,
  };

  it("accepts a context that matches the schema", () => {
    expect(() => validateSagaContext({ orderId: "o1" }, schema)).not.toThrow();
  });

  it("rejects a context missing a required property", () => {
    expect(() => validateSagaContext({}, schema)).toThrow(SagaContextValidationError);
  });

  it("rejects a context with a wrong-typed property", () => {
    expect(() => validateSagaContext({ orderId: 123 }, schema)).toThrow(SagaContextValidationError);
  });

  it("rejects non-object context", () => {
    expect(() => validateSagaContext(null, schema)).toThrow(SagaContextValidationError);
  });
});
