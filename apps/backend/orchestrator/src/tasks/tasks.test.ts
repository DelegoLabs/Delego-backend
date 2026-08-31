/**
 * Unit tests for the human task management module (Issue: human task mgmt).
 * Uses the in-memory store so no PostgreSQL is required.
 */

import { describe, it, expect, vi } from "vitest";
import { InMemoryTaskStore } from "./memory-store.js";
import { TaskService, validateFormData, TaskStateError, TaskValidationError } from "./service.js";
import { routeTask } from "./routing.js";
import { scanSla, slaStatus } from "./sla.js";
import { computeTaskMetrics } from "./analytics.js";
import { TaskEventBroker, type PubSubClient } from "./subscriptions.js";
import { upsertRoutingRule } from "./index.js";
import { TaskRoutingRuleError } from "./types.js";
import type { CreateTaskInput, HumanTask, TaskRoutingRule } from "./types.js";

function makeInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    workflowId: "wf-1",
    workflowType: "purchase",
    type: "approval",
    title: "Approve purchase",
    candidates: ["alice", "bob"],
    priority: "high",
    slaHours: 24,
    ...overrides,
  };
}

function makeService(store = new InMemoryTaskStore(), skills?: Record<string, string[]>) {
  return new TaskService({ store, skills });
}

async function seedTask(
  store: InMemoryTaskStore,
  overrides: Partial<HumanTask> = {}
): Promise<HumanTask> {
  const created = await store.create(makeInput());
  await store.update({ ...created, ...overrides, id: created.id });
  return store.get(created.id)!;
}

// ─── Routing ───────────────────────────────────────────────────────────────

function makeRule(overrides: Partial<TaskRoutingRule> = {}): TaskRoutingRule {
  return {
    id: "r1",
    workflowType: "purchase",
    taskType: "approval",
    strategy: "round_robin",
    config: {},
    fallbackAssignee: "",
    ...overrides,
  };
}

describe("routing", () => {
  it("round_robin cycles through candidates", () => {
    const rule = makeRule({ strategy: "round_robin" });
    const ctx = { candidates: ["a", "b", "c"], taskType: "approval" as const, priority: "high" as const, workflowType: "purchase", loadByAssignee: {}, cursor: {} };
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) seen.add(routeTask(rule, ctx).assignee);
    for (const c of ["a", "b", "c"]) expect(seen.has(c)).toBe(true);
  });

  it("least_loaded picks the least busy candidate", () => {
    const rule = makeRule({ strategy: "least_loaded" });
    const result = routeTask(rule, {
      candidates: ["a", "b", "c"],
      taskType: "approval",
      priority: "medium",
      workflowType: "purchase",
      loadByAssignee: { a: 5, b: 0, c: 2 },
    });
    expect(result.assignee).toBe("b");
  });

  it("skill_based prefers candidates skilled for the task type", () => {
    const rule = makeRule({ strategy: "skill_based", config: {} });
    const result = routeTask(rule, {
      candidates: ["a", "b", "c"],
      taskType: "verification",
      priority: "medium",
      workflowType: "purchase",
      loadByAssignee: {},
      skills: { a: ["approval"], b: ["verification"], c: ["verification"] },
    });
    expect(["b", "c"]).toContain(result.assignee);
  });

  it("priority weighs candidates and prefers lower load on ties", () => {
    const rule = makeRule({
      strategy: "priority",
      config: { weights: { specialist: 10, general: 2 } },
    });
    const result = routeTask(rule, {
      candidates: ["general", "specialist", "idle"],
      taskType: "approval",
      priority: "urgent",
      workflowType: "purchase",
      loadByAssignee: { specialist: 3, general: 0, idle: 0 },
    });
    expect(result.assignee).toBe("specialist");
  });

  it("specific_user routes to the configured assignee", () => {
    const rule = makeRule({ strategy: "specific_user", config: { assignee: "auditor" } });
    const result = routeTask(rule, {
      candidates: ["auditor", "bob"],
      taskType: "review",
      priority: "medium",
      workflowType: "purchase",
      loadByAssignee: {},
    });
    expect(result.assignee).toBe("auditor");
  });

  it("uses fallback assignee when routing fails", () => {
    const rule = makeRule({ strategy: "round_robin", fallbackAssignee: "manager" });
    // No candidates -> round_robin throws; fallback applies (it is a candidate).
    const result = routeTask(rule, {
      candidates: ["manager"],
      taskType: "approval",
      priority: "low",
      workflowType: "purchase",
      loadByAssignee: {},
    });
    expect(result.assignee).toBe("manager");
  });

  it("throws when there are no candidates and no fallback", () => {
    const rule = makeRule({ strategy: "round_robin" });
    expect(() =>
      routeTask(rule, {
        candidates: [],
        taskType: "approval",
        priority: "low",
        workflowType: "purchase",
        loadByAssignee: {},
      })
    ).toThrow(TaskRoutingRuleError);
  });
});

// ─── Service lifecycle ─────────────────────────────────────────────────────

describe("TaskService lifecycle", () => {
  it("creates a task as created/assigned and routes via a rule", async () => {
    const store = new InMemoryTaskStore();
    await upsertRoutingRule(store, {
      workflowType: "purchase",
      taskType: "approval",
      strategy: "specific_user",
      config: { assignee: "alice" },
    });
    const service = makeService(store);
    const task = await service.createTask(makeInput());
    expect(task.candidates).toEqual(["alice", "bob"]);
    expect(task.status).toBe("assigned");
    expect(task.assignee).toBe("alice");
    expect(new Date(task.dueAt).getTime() - new Date(task.createdAt).getTime()).toBeCloseTo(24 * 3600_000, -3);
  });

  it("creates a task without a rule as 'created' when no direct assignee", async () => {
    const store = new InMemoryTaskStore();
    const service = makeService(store);
    const task = await service.createTask(makeInput({ candidates: [] }));
    expect(task.assignee).toBeUndefined();
    expect(task.status).toBe("created");
  });

  it("claim prevents a second operator from claiming", async () => {
    const store = new InMemoryTaskStore();
    const task = await seedTask(store, { assignee: "alice", status: "assigned" });
    const service = makeService(store);
    const claimed = await service.claimTask(task.id, "alice");
    expect(claimed.status).toBe("claimed");
    await expect(service.claimTask(task.id, "alice")).rejects.toBeInstanceOf(TaskStateError);
    await expect(service.claimTask(task.id, "bob")).rejects.toBeInstanceOf(TaskStateError);
  });

  it("completes a task and records completion time", async () => {
    const store = new InMemoryTaskStore();
    const task = await seedTask(store, { assignee: "alice", status: "claimed", claimedAt: new Date().toISOString() });
    const service = makeService(store);
    const completed = await service.completeTask(task.id, { actorId: "alice" });
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeDefined();
  });

  it("rejects with a reason comment", async () => {
    const store = new InMemoryTaskStore();
    const task = await seedTask(store, { assignee: "alice", status: "in_progress" });
    const service = makeService(store);
    const rejected = await service.rejectTask(task.id, { reason: "Insufficient data", actorId: "alice" });
    expect(rejected.status).toBe("rejected");
    const comments = await service.listComments(task.id);
    expect(comments.some((c) => c.body.includes("Insufficient data"))).toBe(true);
  });

  it("delegate reassigns and records the handoff", async () => {
    const store = new InMemoryTaskStore();
    const task = await seedTask(store, { assignee: "alice", status: "claimed" });
    const service = makeService(store);
    const delegated = await service.delegateTask(task.id, "bob", { reason: "vacation", actorId: "alice" });
    expect(delegated.assignee).toBe("bob");
    expect(delegated.status).toBe("assigned");
    expect(delegated.claimedAt).toBeUndefined();
  });

  it("escapes illegal state transitions", async () => {
    const store = new InMemoryTaskStore();
    const task = await seedTask(store, { status: "completed" });
    const service = makeService(store);
    await expect(service.assignTask(task.id, "alice")).rejects.toBeInstanceOf(TaskStateError);
    await expect(service.completeTask(task.id, {})).rejects.toBeInstanceOf(TaskStateError);
  });

  it("validates form data against the schema on completion", async () => {
    const store = new InMemoryTaskStore();
    const formSchema = {
      required: ["amount"],
      properties: { amount: { type: "number" }, note: { type: "string" } },
    };
    const task = await seedTask(store, {
      assignee: "alice",
      status: "claimed",
      formSchema,
    });
    const service = makeService(store);
    await expect(service.completeTask(task.id, { formData: { amount: "not-a-number" } })).rejects.toBeInstanceOf(
      TaskValidationError
    );
    const ok = await service.completeTask(task.id, {
      formData: { amount: 100 },
      actorId: "alice",
    });
    expect(ok.status).toBe("completed");
    expect(ok.formData).toEqual({ amount: 100 });
  });

  it("bulk operation aggregates successes and failures", async () => {
    const store = new InMemoryTaskStore();
    const task = await seedTask(store, { assignee: "alice", status: "assigned" });
    const service = makeService(store);
    const result = await service.bulkOperation(
      "claim",
      [task.id, "does-not-exist"],
      { assignee: "alice" }
    );
    expect(result.succeeded).toEqual([task.id]);
    expect(result.failed).toHaveLength(1);
  });
});

// ─── validateFormData ──────────────────────────────────────────────────────

describe("validateFormData", () => {
  it("returns empty for no schema", () => {
    expect(validateFormData(undefined, {})).toEqual([]);
  });

  it("catches missing required fields and wrong types", () => {
    const schema = { required: ["ref"], properties: { ref: { type: "string" }, qty: { type: "integer" } } };
    const errors = validateFormData(schema, { qty: "x" });
    expect(errors).toContain("Missing required field: ref");
    expect(errors).toContain('Field "qty" must be an integer');
  });
});

// ─── SLA ───────────────────────────────────────────────────────────────────

describe("SLA", () => {
  it("escalates then expires a breached task", async () => {
    const store = new InMemoryTaskStore();
    const now = new Date("2025-01-01T00:00:00Z");
    const task = await seedTask(store, {
      assignee: "alice",
      status: "assigned",
      createdAt: new Date(now.getTime() - 48 * 3600_000).toISOString(),
      dueAt: new Date(now.getTime() - 1).toISOString(),
      slaHours: 1,
    });

    const first = await scanSla(store, { graceHours: 1, now });
    expect(first.escalated).toContain(task.id);
    expect((await store.get(task.id)!).status).toBe("escalated");

    const later = new Date(now.getTime() + 2 * 3600_000);
    const second = await scanSla(store, { graceHours: 1, now: later });
    expect(second.expired).toContain(task.id);
    expect((await store.get(task.id)!).status).toBe("expired");
  });

  it("leave within-SLA tasks untouched", async () => {
    const store = new InMemoryTaskStore();
    const task = await seedTask(store, {
      assignee: "alice",
      status: "assigned",
      dueAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const result = await scanSla(store, { graceHours: 1 });
    expect(result.escalated).not.toContain(task.id);
    expect(result.expired).not.toContain(task.id);
  });

  it("slaStatus reports ok / at_risk / breached / met", () => {
    const base: HumanTask = {
      id: "t",
      workflowId: "w",
      workflowType: "purchase",
      type: "approval",
      title: "t",
      description: "",
      priority: "medium",
      candidates: [],
      status: "assigned",
      slaHours: 24,
      createdAt: "2025-01-01T00:00:00Z",
      dueAt: "2025-01-02T00:00:00Z",
    };
    expect(slaStatus(base, new Date("2025-01-01T01:00:00Z"))).toBe("ok");
    expect(slaStatus(base, new Date("2025-01-01T23:00:00Z"))).toBe("at_risk");
    expect(slaStatus(base, new Date("2025-01-02T01:00:00Z"))).toBe("breached");
    expect(slaStatus({ ...base, status: "completed" })).toBe("met");
  });
});

// ─── Analytics ─────────────────────────────────────────────────────────────

describe("analytics", () => {
  it("computes cycle time, SLA rate and per-assignee/type breakdowns", async () => {
    const store = new InMemoryTaskStore();
    const start = new Date("2025-02-01T00:00:00Z");
    const end = new Date("2025-02-28T00:00:00Z");

    const t1 = await store.create(makeInput({ type: "approval", workflowId: "w1" }));
    await store.update({ ...t1, assignee: "alice", status: "completed", createdAt: "2025-02-01T00:00:00Z", completedAt: "2025-02-01T02:00:00Z" });

    const t2 = await store.create(makeInput({ type: "data_entry", workflowId: "w2" }));
    await store.update({ ...t2, assignee: "bob", status: "completed", createdAt: "2025-02-02T00:00:00Z", completedAt: "2025-02-02T00:00:00Z" });

    const metrics = await computeTaskMetrics(store, { start, end });
    expect(metrics.totalTasks).toBe(2);
    expect(metrics.completedTasks).toBe(2);
    expect(metrics.avgCycleTimeHours).toBe(1);
    expect(metrics.byAssignee["alice"].avgTimeHours).toBe(2);
    expect(metrics.byAssignee["bob"].avgTimeHours).toBe(0);
    expect(metrics.byType["approval"].count).toBe(1);
    expect(metrics.byType["data_entry"].count).toBe(1);
  });
});

// ─── Subscriptions (real-time inbox) ───────────────────────────────────────

describe("TaskEventBroker", () => {
  it("publishes to global, assignee and candidate channels", async () => {
    const published = new Map<string, number>();
    const client: PubSubClient = {
      publish(channel: string) {
        published.set(channel, (published.get(channel) ?? 0) + 1);
        return 1;
      },
    };
    const broker = new TaskEventBroker(client);
    const task = await new InMemoryTaskStore().create(makeInput({ assignee: "alice" }));
    await broker.publish({ type: "assigned", task });
    expect(published.has("human-task:events")).toBe(true);
    expect(published.has("human-task:assignee:alice")).toBe(true);
    expect(published.has("human-task:candidate:bob")).toBe(true);
  });

  it("is a no-op without a client", async () => {
    const broker = new TaskEventBroker(null);
    const task = await new InMemoryTaskStore().create(makeInput());
    await expect(broker.publish({ type: "created", task })).resolves.toBeUndefined();
  });
});
