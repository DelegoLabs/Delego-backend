import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pendingReleaseJobCount, resetReleaseQueue, runDueReleaseJobs, scheduleRelease } from "./releaseQueue.js";

describe("scheduleRelease (in-memory / test backend)", () => {
  beforeEach(() => {
    resetReleaseQueue();
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    resetReleaseQueue();
  });

  it("does not execute the job immediately when delayMinutes > 0", async () => {
    const executor = vi.fn().mockResolvedValue(undefined);

    const result = await scheduleRelease(
      { escrowId: "42", orderId: "order-1", confirmedBy: "merchant-1", timestamp: "2026-01-01T00:00:00.000Z" },
      5,
      executor
    );

    expect(result.backend).toBe("in-memory");
    expect(executor).not.toHaveBeenCalled();
    expect(pendingReleaseJobCount()).toBe(1);
  });

  it("runs the job once its delay has elapsed via runDueReleaseJobs", async () => {
    const executor = vi.fn().mockResolvedValue(undefined);
    const start = Date.now();

    await scheduleRelease(
      { escrowId: "42", orderId: "order-1", confirmedBy: "merchant-1", timestamp: "2026-01-01T00:00:00.000Z" },
      5,
      executor
    );

    // Not yet due at t+1min.
    const ranEarly = await runDueReleaseJobs(start + 60_000);
    expect(ranEarly).toBe(0);
    expect(executor).not.toHaveBeenCalled();

    // Due at t+5min.
    const ranOnTime = await runDueReleaseJobs(start + 5 * 60_000 + 1);
    expect(ranOnTime).toBe(1);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(pendingReleaseJobCount()).toBe(0);
  });

  it("schedules multiple jobs independently and only runs the due ones", async () => {
    const fastExecutor = vi.fn().mockResolvedValue(undefined);
    const slowExecutor = vi.fn().mockResolvedValue(undefined);
    const start = Date.now();

    await scheduleRelease(
      { escrowId: "1", orderId: "order-1", confirmedBy: "m1", timestamp: "t1" },
      1,
      fastExecutor
    );
    await scheduleRelease(
      { escrowId: "2", orderId: "order-2", confirmedBy: "m2", timestamp: "t2" },
      10,
      slowExecutor
    );

    const ran = await runDueReleaseJobs(start + 2 * 60_000);
    expect(ran).toBe(1);
    expect(fastExecutor).toHaveBeenCalledTimes(1);
    expect(slowExecutor).not.toHaveBeenCalled();
    expect(pendingReleaseJobCount()).toBe(1);
  });
});
