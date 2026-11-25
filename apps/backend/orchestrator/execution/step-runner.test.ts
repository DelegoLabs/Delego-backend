import { describe, expect, it, vi } from "vitest";

import { runWithBoundedRetry, StepRunner } from "./step-runner.js";

interface Context {
  completed: string[];
}

describe("StepRunner", () => {
  it("retries a step within its lease and fully compensates completed work in reverse", async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const order: string[] = [];
    let attempts = 0;
    const runner = new StepRunner<Context>(
      [
        {
          name: "reserve",
          execute: async (context) => ({ completed: [...context.completed, "reserve"] }),
          compensate: async (context) => {
            order.push("undo-reserve");
            return { completed: context.completed.filter((step) => step !== "reserve") };
          },
        },
        {
          name: "charge",
          retryPolicy: { maxAttempts: 4, backoffMs: 10, maxBackoffMs: 20 },
          async execute() {
            attempts += 1;
            throw new Error("transient charge failure");
          },
          async compensate(context) {
            order.push("undo-charge");
            return context;
          },
        },
        {
          name: "notify",
          execute: async (context) => ({ completed: [...context.completed, "notify"] }),
          compensate: async (context) => context,
        },
      ],
      { leaseDeadlineMs: 25, now: () => now, sleep },
    );

    const result = await runner.run({ completed: [] });

    expect(result.status).toBe("compensated");
    expect(result.completedSteps).toEqual(["reserve"]);
    expect(result.compensatedSteps).toEqual(["reserve"]);
    expect(result.failure?.step).toBe("charge");
    expect(result.context.completed).toEqual([]);
    expect(attempts).toBe(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(order).toEqual(["undo-reserve"]);
  });

  it("continues reverse compensation after a rollback step fails", async () => {
    const order: string[] = [];
    const runner = new StepRunner<Context>([
      {
        name: "first",
        execute: async (context) => ({ completed: [...context.completed, "first"] }),
        compensate: async (context) => {
          order.push("undo-first");
          return { completed: context.completed.filter((step) => step !== "first") };
        },
      },
      {
        name: "second",
        execute: async (context) => ({ completed: [...context.completed, "second"] }),
        compensate: async () => {
          order.push("undo-second");
          throw new Error("rollback failed");
        },
      },
      {
        name: "third",
        execute: async () => {
          throw new Error("forward failure");
        },
        compensate: async (context) => context,
      },
    ]);

    const result = await runner.run({ completed: [] });

    expect(result.status).toBe("partial_failure");
    expect(result.compensatedSteps).toEqual(["first"]);
    expect(result.failedCompensations).toEqual([{ step: "second", error: "rollback failed" }]);
    expect(result.context.completed).toEqual(["second"]);
    expect(order).toEqual(["undo-second", "undo-first"]);
  });

  it("uses capped exponential backoff for a step retry policy", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const result = await runWithBoundedRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("temporary");
        return "done";
      },
      { maxAttempts: 3, backoffMs: 10, maxBackoffMs: 15 },
      {
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(result).toBe("done");
    expect(delays).toEqual([10, 15]);
  });

  it("does not start a retry after sleeping past the lease deadline", async () => {
    let now = 0;
    let attempts = 0;
    await expect(
      runWithBoundedRetry(
        async () => {
          attempts += 1;
          throw new Error("temporary");
        },
        { maxAttempts: 3, backoffMs: 10 },
        {
          leaseDeadlineMs: 20,
          now: () => now,
          sleep: async () => {
            now = 20;
          },
        },
      ),
    ).rejects.toThrow("temporary");

    expect(attempts).toBe(1);
  });
});
