import { describe, it, expect, beforeEach } from "vitest";
// @ts-ignore -- ioredis-mock has no first-party types
import MockRedis from "ioredis-mock";
import type { CacheRedisClient } from "./client.js";
import {
  redisLockAcquire,
  redisLockRelease,
  redisLockRenew,
  redisLockInspect,
  workflowLockKey,
  stepLockKey,
  fenceKeyFor,
} from "./lock.js";

let nextMockPort = 20000;
function newClient(): CacheRedisClient {
  return new MockRedis(nextMockPort++) as unknown as CacheRedisClient;
}

describe("redis lock primitives", () => {
  let client: CacheRedisClient;
  const key = workflowLockKey("saga-1");

  beforeEach(() => {
    client = newClient();
  });

  it("acquires under no contention with a fence and TTL", async () => {
    const started = Date.now();
    const result = await redisLockAcquire(client, key, "instance-a", 5_000, { level: "workflow" });
    // Deployment target is under 10ms against local Redis; ioredis-mock first eval is slower in CI.
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.acquired).toBe(true);
    expect(result.payload?.owner).toBe("instance-a");
    expect(result.payload?.fence).toBe(1);
    const inspect = await redisLockInspect(client, key);
    expect(inspect.pttlMs).toBeGreaterThan(0);
    expect(inspect.pttlMs).toBeLessThanOrEqual(5_000);
  });

  it("refuses a second acquire while the lock is held", async () => {
    await redisLockAcquire(client, key, "instance-a", 30_000);
    const second = await redisLockAcquire(client, key, "instance-b", 30_000);
    expect(second.acquired).toBe(false);
    expect(second.payload?.owner).toBe("instance-a");
  });

  it("releases only when the owner matches", async () => {
    await redisLockAcquire(client, key, "instance-a", 30_000);
    expect(await redisLockRelease(client, key, "instance-b")).toBe(false);
    expect((await redisLockInspect(client, key)).payload?.owner).toBe("instance-a");
    expect(await redisLockRelease(client, key, "instance-a")).toBe(true);
    expect((await redisLockInspect(client, key)).payload).toBeNull();
  });

  it("renews TTL for the owner and reports steal for a different owner", async () => {
    const first = await redisLockAcquire(client, key, "instance-a", 2_000);
    const renewed = await redisLockRenew(client, key, "instance-a", 10_000, {}, first.payload!.fence);
    expect(renewed).toBe("ok");
    expect((await redisLockInspect(client, key)).pttlMs).toBeGreaterThan(2_000);

    const stolen = await redisLockRenew(client, key, "instance-b", 10_000, {}, 1);
    expect(stolen).toBe("stolen");
  });

  it("allows re-acquire after TTL expiry", async () => {
    await redisLockAcquire(client, key, "instance-a", 50);
    await new Promise((r) => setTimeout(r, 80));
    const second = await redisLockAcquire(client, key, "instance-b", 1_000);
    expect(second.acquired).toBe(true);
    expect(second.payload?.owner).toBe("instance-b");
    expect(second.payload!.fence).toBeGreaterThan(1);
  });

  it("increments the fence across acquire attempts", async () => {
    await redisLockAcquire(client, key, "a", 50);
    await new Promise((r) => setTimeout(r, 80));
    const again = await redisLockAcquire(client, key, "b", 1_000);
    expect(again.payload!.fence).toBeGreaterThanOrEqual(2);
    expect(await client.get(fenceKeyFor(key))).toBeTruthy();
  });

  it("places workflow and step keys on the same hash tag", () => {
    const wf = workflowLockKey("order-9");
    const step = stepLockKey("order-9", "deposit-escrow");
    expect(wf).toContain("{workflow:order-9}");
    expect(step).toContain("{workflow:order-9}");
  });
});
