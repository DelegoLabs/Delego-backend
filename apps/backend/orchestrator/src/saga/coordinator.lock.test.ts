import { describe, it, expect, afterEach } from "vitest";
// @ts-ignore -- ioredis-mock has no first-party types
import MockRedis from "ioredis-mock";
import type { CacheRedisClient } from "@delegolabs/cache";
import { SagaCoordinator } from "./coordinator.js";
import { InMemorySagaStore } from "./memory-store.js";
import { DistributedLockManager } from "../locks/manager.js";

let nextPort = 32000;

describe("SagaCoordinator distributed locks", () => {
  const managers: DistributedLockManager[] = [];

  afterEach(async () => {
    for (const m of managers) await m.releaseAll();
    managers.length = 0;
  });

  function pair() {
    const redis = new MockRedis(nextPort++) as unknown as CacheRedisClient;
    const store = new InMemorySagaStore();
    const locksA = new DistributedLockManager({ client: redis, owner: "coord-a" });
    const locksB = new DistributedLockManager({ client: redis, owner: "coord-b" });
    managers.push(locksA, locksB);
    return { store, locksA, locksB };
  }

  it("only one coordinator executes a step when two run the same saga", async () => {
    const { store, locksA, locksB } = pair();
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const step = {
      name: "work",
      async action(context: Record<string, unknown>) {
        entered += 1;
        await gate;
        return { ...context, done: true };
      },
      async compensation(context: Record<string, unknown>) {
        return context;
      },
    };

    const a = new SagaCoordinator({ steps: [step], store, locks: locksA, claimLeaseMs: 30_000 });
    const b = new SagaCoordinator({ steps: [step], store, locks: locksB, claimLeaseMs: 30_000 });

    const runA = a.run("saga-lock-1", "order-1", {});
    for (let i = 0; i < 50 && entered === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(entered).toBe(1);
    const runB = b.run("saga-lock-1", "order-1", {});
    const bResult = await runB;
    expect(entered).toBe(1);
    expect(bResult.status).toBe("running");
    release();
    const aResult = await runA;
    expect(aResult.status).toBe("completed");
    expect(entered).toBe(1);
  });
});
