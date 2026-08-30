import { describe, expect, it, beforeEach } from "vitest";
import { InMemoryTokenBucketStore } from "./store.js";

describe("InMemoryTokenBucketStore", () => {
  let store: InMemoryTokenBucketStore;

  beforeEach(() => {
    store = new InMemoryTokenBucketStore();
  });

  it("starts a new bucket at full capacity and allows the first request", async () => {
    const result = await store.consume("k1", 10, 0.01, 1, 1000, 60);
    expect(result.allowed).toBe(true);
    expect(result.tokensRemaining).toBe(9);
  });

  it("denies once the bucket is exhausted", async () => {
    const capacity = 3;
    for (let i = 0; i < capacity; i++) {
      const r = await store.consume("k2", capacity, 0, 1, 1000, 60);
      expect(r.allowed).toBe(true);
    }
    const denied = await store.consume("k2", capacity, 0, 1, 1000, 60);
    expect(denied.allowed).toBe(false);
    expect(denied.tokensRemaining).toBe(0);
  });

  it("refills tokens proportionally to elapsed time, capped at capacity", async () => {
    const capacity = 5;
    const refillPerMs = 0.001; // 1 token per second

    // Drain the bucket.
    for (let i = 0; i < capacity; i++) {
      await store.consume("k3", capacity, refillPerMs, 1, 0, 60);
    }
    const drained = await store.consume("k3", capacity, refillPerMs, 1, 0, 60);
    expect(drained.allowed).toBe(false);

    // 2.5s later — 2.5 tokens should have refilled.
    const afterRefill = await store.consume("k3", capacity, refillPerMs, 1, 2500, 60);
    expect(afterRefill.allowed).toBe(true);
    expect(afterRefill.tokensRemaining).toBeCloseTo(1.5, 5);

    // A very long idle period never overfills past capacity.
    const afterLongIdle = await store.consume("k3", capacity, refillPerMs, 1, 1_000_000, 60);
    expect(afterLongIdle.tokensRemaining).toBe(capacity - 1);
  });

  it("tracks independent buckets per key", async () => {
    await store.consume("a", 1, 0, 1, 0, 60);
    const bFirst = await store.consume("b", 1, 0, 1, 0, 60);
    expect(bFirst.allowed).toBe(true);
  });

  it("supports consuming more than 1 token at a time", async () => {
    const result = await store.consume("k4", 10, 0, 5, 0, 60);
    expect(result.allowed).toBe(true);
    expect(result.tokensRemaining).toBe(5);

    const second = await store.consume("k4", 10, 0, 5, 0, 60);
    expect(second.allowed).toBe(true);
    expect(second.tokensRemaining).toBe(0);

    const third = await store.consume("k4", 10, 0, 1, 0, 60);
    expect(third.allowed).toBe(false);
  });

  it("reset() clears all bucket state", async () => {
    await store.consume("k5", 1, 0, 1, 0, 60);
    const deniedBefore = await store.consume("k5", 1, 0, 1, 0, 60);
    expect(deniedBefore.allowed).toBe(false);

    store.reset();

    const afterReset = await store.consume("k5", 1, 0, 1, 0, 60);
    expect(afterReset.allowed).toBe(true);
  });
});
