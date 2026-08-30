/**
 * Unit tests for #33 — OutboxRelay: batch polling, publish, retry backoff,
 * terminal failure after maxAttempts, and concurrent-claim safety.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "@delegolabs/utils";
import {
  computeBackoffDelayMs,
  runOutboxRelayCycle,
  startOutboxRelay,
} from "./outboxRelay.js";
import {
  InMemoryServiceEventOutboxStore,
  resetServiceEventOutboxStore,
} from "./service-event-outbox.js";
import type { RedisClient } from "../pubsub/types.js";
import { RedisPublisher } from "../pubsub/publisher.js";

function noopLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("computeBackoffDelayMs", () => {
  it("grows exponentially with attempts before jitter is applied", () => {
    // With random() pinned to 1, the jittered delay equals the capped exponential exactly.
    const always1 = () => 1;
    expect(computeBackoffDelayMs(1, 100, 30_000, always1)).toBe(100);
    expect(computeBackoffDelayMs(2, 100, 30_000, always1)).toBe(200);
    expect(computeBackoffDelayMs(3, 100, 30_000, always1)).toBe(400);
    expect(computeBackoffDelayMs(4, 100, 30_000, always1)).toBe(800);
  });

  it("caps the delay at maxBackoffMs regardless of attempt count", () => {
    const always1 = () => 1;
    expect(computeBackoffDelayMs(20, 100, 5000, always1)).toBe(5000);
  });

  it("applies full jitter — result is within [0, cappedDelay]", () => {
    const fixed = () => 0.5;
    // attempt 3 => exponential = 100 * 2^2 = 400; jittered = 0.5 * 400 = 200
    expect(computeBackoffDelayMs(3, 100, 30_000, fixed)).toBe(200);
  });

  it("treats attempts <= 1 as the first attempt (no negative exponent)", () => {
    const always1 = () => 1;
    expect(computeBackoffDelayMs(0, 100, 30_000, always1)).toBe(100);
  });
});

describe("runOutboxRelayCycle", () => {
  let store: InMemoryServiceEventOutboxStore;

  beforeEach(() => {
    resetServiceEventOutboxStore();
    store = new InMemoryServiceEventOutboxStore();
  });

  it("does nothing when there are no pending rows", async () => {
    const publisher = { publish: vi.fn() };
    const metrics = await runOutboxRelayCycle(store, publisher, { log: noopLogger() });

    expect(metrics.claimed).toBe(0);
    expect(metrics.published).toBe(0);
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("publishes a pending row and marks it published", async () => {
    await store.insert({ topic: "payments:events", payload: { orderId: "ord-1" } });
    const publisher = {
      publish: vi.fn().mockResolvedValue({ channel: "payments:events", delivered: true, attempts: 1 }),
    };

    const metrics = await runOutboxRelayCycle(store, publisher, { log: noopLogger() });

    expect(metrics.claimed).toBe(1);
    expect(metrics.published).toBe(1);
    expect(publisher.publish).toHaveBeenCalledWith("payments:events", JSON.stringify({ orderId: "ord-1" }));

    const [row] = store.snapshot();
    expect(row.status).toBe("published");
    expect(row.publishedAt).not.toBeNull();
  });

  it("respects batchSize, leaving extra rows pending for the next cycle", async () => {
    await store.insert({ topic: "t", payload: { i: 1 } });
    await store.insert({ topic: "t", payload: { i: 2 } });
    await store.insert({ topic: "t", payload: { i: 3 } });
    const publisher = {
      publish: vi.fn().mockResolvedValue({ channel: "t", delivered: true, attempts: 1 }),
    };

    const metrics = await runOutboxRelayCycle(store, publisher, { batchSize: 2, log: noopLogger() });

    expect(metrics.claimed).toBe(2);
    expect(metrics.published).toBe(2);
    const pendingRemaining = store.snapshot().filter((r) => r.status === "pending");
    expect(pendingRemaining).toHaveLength(1);
  });

  it("retries a failed publish and keeps the row pending with next_attempt_at in the future", async () => {
    await store.insert({ topic: "t", payload: {} });
    const publisher = {
      publish: vi.fn().mockResolvedValue({ channel: "t", delivered: false, error: "ECONNREFUSED" }),
    };
    const fixedNow = new Date(Date.now() + 3_600_000);

    const metrics = await runOutboxRelayCycle(store, publisher, {
      maxAttempts: 5,
      baseBackoffMs: 100,
      maxBackoffMs: 30_000,
      log: noopLogger(),
      now: () => fixedNow,
    });

    expect(metrics.retried).toBe(1);
    expect(metrics.exhausted).toBe(0);

    const [row] = store.snapshot();
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe("ECONNREFUSED");
    expect(new Date(row.nextAttemptAt).getTime()).toBeGreaterThan(fixedNow.getTime());
  });

  it("marks a row terminally failed once attempts reach maxAttempts", async () => {
    await store.insert({ topic: "t", payload: {} });
    const publisher = {
      publish: vi.fn().mockResolvedValue({ channel: "t", delivered: false, error: "boom" }),
    };

    // maxAttempts=1 so the very first failure exhausts retries.
    const metrics = await runOutboxRelayCycle(store, publisher, {
      maxAttempts: 1,
      log: noopLogger(),
    });

    expect(metrics.exhausted).toBe(1);
    expect(metrics.retried).toBe(0);
    const [row] = store.snapshot();
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
  });

  it("does not re-claim a row still within its backoff window", async () => {
    await store.insert({ topic: "t", payload: {} });
    const failingPublisher = {
      publish: vi.fn().mockResolvedValue({ channel: "t", delivered: false, error: "down" }),
    };
    const t0 = new Date(Date.now() + 3_600_000);

    await runOutboxRelayCycle(store, failingPublisher, {
      maxAttempts: 5,
      baseBackoffMs: 10_000,
      maxBackoffMs: 10_000,
      log: noopLogger(),
      now: () => t0,
    });

    // Poll again immediately (same instant) — the row's next_attempt_at is in the future,
    // so it must not be claimed yet.
    const secondPublisher = { publish: vi.fn() };
    const metrics = await runOutboxRelayCycle(store, secondPublisher, {
      log: noopLogger(),
      now: () => t0,
    });

    expect(metrics.claimed).toBe(0);
    expect(secondPublisher.publish).not.toHaveBeenCalled();
  });

  it("claims a retried row again once its backoff window has elapsed", async () => {
    await store.insert({ topic: "t", payload: {} });
    const failingPublisher = {
      publish: vi.fn().mockResolvedValue({ channel: "t", delivered: false, error: "down" }),
    };
    const t0 = new Date(Date.now() + 3_600_000);

    await runOutboxRelayCycle(store, failingPublisher, {
      maxAttempts: 5,
      baseBackoffMs: 1000,
      maxBackoffMs: 1000,
      log: noopLogger(),
      now: () => t0,
    });

    const later = new Date(t0.getTime() + 60_000);
    const recoveredPublisher = {
      publish: vi.fn().mockResolvedValue({ channel: "t", delivered: true, attempts: 1 }),
    };
    const metrics = await runOutboxRelayCycle(store, recoveredPublisher, {
      log: noopLogger(),
      now: () => later,
    });

    expect(metrics.claimed).toBe(1);
    expect(metrics.published).toBe(1);
  });

  it("treats a publish() that throws the same as a delivered:false result", async () => {
    await store.insert({ topic: "t", payload: {} });
    const publisher = { publish: vi.fn().mockRejectedValue(new Error("network down")) };

    const metrics = await runOutboxRelayCycle(store, publisher, { maxAttempts: 5, log: noopLogger() });

    expect(metrics.retried).toBe(1);
    const [row] = store.snapshot();
    expect(row.lastError).toBe("network down");
  });

  it("continues publishing remaining rows in the batch after one row fails", async () => {
    await store.insert({ topic: "a", payload: {} });
    await store.insert({ topic: "b", payload: {} });
    const publisher = {
      publish: vi
        .fn()
        .mockResolvedValueOnce({ channel: "a", delivered: false, error: "fail" })
        .mockResolvedValueOnce({ channel: "b", delivered: true, attempts: 1 }),
    };

    const metrics = await runOutboxRelayCycle(store, publisher, { maxAttempts: 5, log: noopLogger() });

    expect(metrics.published).toBe(1);
    expect(metrics.retried).toBe(1);
    expect(publisher.publish).toHaveBeenCalledTimes(2);
  });
});

describe("concurrent-claim safety", () => {
  beforeEach(() => {
    resetServiceEventOutboxStore();
  });

  it("never lets two concurrent claimPendingBatch calls claim the same row", async () => {
    const store = new InMemoryServiceEventOutboxStore();
    await store.insert({ topic: "t", payload: { i: 1 } });
    await store.insert({ topic: "t", payload: { i: 2 } });
    await store.insert({ topic: "t", payload: { i: 3 } });

    const now = new Date();
    const [batchA, batchB] = await Promise.all([
      store.claimPendingBatch(2, now),
      store.claimPendingBatch(2, now),
    ]);

    const claimedIds = [...batchA, ...batchB].map((r) => r.id);
    const uniqueIds = new Set(claimedIds);

    // No id appears in both batches — the second concurrent claim only sees rows
    // the first one didn't already take.
    expect(uniqueIds.size).toBe(claimedIds.length);
    expect(claimedIds.length).toBeLessThanOrEqual(3);
  });

  it("releases a claim back to pending after recordFailure so a later poll can retry it", async () => {
    const store = new InMemoryServiceEventOutboxStore();
    const record = await store.insert({ topic: "t", payload: {} });

    const [claimed] = await store.claimPendingBatch(10, new Date());
    expect(claimed.id).toBe(record.id);

    // While claimed, a concurrent poll must not see it again.
    const duringClaim = await store.claimPendingBatch(10, new Date());
    expect(duringClaim).toHaveLength(0);

    await store.recordFailure(record.id, "boom", new Date(Date.now() - 1), 5);

    // After the failure releases the claim (and next_attempt_at is already due), it's claimable again.
    const afterFailure = await store.claimPendingBatch(10, new Date());
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0].id).toBe(record.id);
  });
});

describe("startOutboxRelay / graceful shutdown", () => {
  beforeEach(() => {
    resetServiceEventOutboxStore();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls on an interval and publishes rows inserted before start", async () => {
    const store = new InMemoryServiceEventOutboxStore();
    await store.insert({ topic: "t", payload: { hello: "world" } });

    const redisClient: RedisClient = { publish: vi.fn().mockResolvedValue(1) };
    const onMetrics = vi.fn();

    const handle = startOutboxRelay({
      store,
      redisClient,
      log: noopLogger(),
      pollIntervalMs: 1000,
      onMetrics,
    });

    // First cycle runs synchronously on start(); flush microtasks.
    await vi.waitFor(() => expect(onMetrics).toHaveBeenCalled());

    const [row] = store.snapshot();
    expect(row.status).toBe("published");

    await handle.stop();
  });

  it("stop() waits for the in-flight cycle to finish before resolving", async () => {
    const store = new InMemoryServiceEventOutboxStore();
    await store.insert({ topic: "t", payload: {} });

    let resolvePublish!: (v: { channel: string; delivered: boolean; attempts: number }) => void;
    const pendingPublish = new Promise<{ channel: string; delivered: boolean; attempts: number }>((resolve) => {
      resolvePublish = resolve;
    });

    const redisClient: RedisClient = {
      publish: vi.fn().mockImplementation(async () => {
        await pendingPublish;
        return 1;
      }),
    };

    const handle = startOutboxRelay({
      store,
      redisClient,
      log: noopLogger(),
      pollIntervalMs: 1000,
    });

    // Give the first cycle a tick to claim the row and call publish().
    await vi.advanceTimersByTimeAsync(0);

    let stopped = false;
    const stopPromise = handle.stop().then(() => {
      stopped = true;
    });

    // stop() must not resolve while the publish() call it's draining is still pending.
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolvePublish({ channel: "t", delivered: true, attempts: 1 });
    await stopPromise;
    expect(stopped).toBe(true);

    const [row] = store.snapshot();
    expect(row.status).toBe("published");
  });

  it("does not start a new cycle after stop() has been called", async () => {
    const store = new InMemoryServiceEventOutboxStore();
    const redisClient: RedisClient = { publish: vi.fn().mockResolvedValue(1) };
    const onMetrics = vi.fn();

    const handle = startOutboxRelay({
      store,
      redisClient,
      log: noopLogger(),
      pollIntervalMs: 1000,
      onMetrics,
    });

    await vi.advanceTimersByTimeAsync(0);
    await handle.stop();

    const callsAtStop = onMetrics.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onMetrics.mock.calls.length).toBe(callsAtStop);
  });
});
