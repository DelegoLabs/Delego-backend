import { describe, it, expect, beforeEach } from "vitest";
import { RedisSessionStore, type SessionRedisClient } from "./redisSessionStore";

class FakeRedis implements SessionRedisClient {
  private strings = new Map<string, string>();
  private sets = new Map<string, Set<string>>();

  async set(key: string, value: string): Promise<string | null> {
    this.strings.set(key, value);
    return "OK";
  }
  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const k of keys) {
      if (this.strings.delete(k)) count++;
      if (this.sets.delete(k)) count++;
    }
    return count;
  }
  async sadd(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    let added = 0;
    for (const m of members) {
      if (!set.has(m)) added++;
      set.add(m);
    }
    this.sets.set(key, set);
    return added;
  }
  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) {
      if (set.delete(m)) removed++;
    }
    return removed;
  }
  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }
  async expire(): Promise<number> {
    return 1;
  }
}

function makeInput(overrides: Partial<Parameters<RedisSessionStore["create"]>[0]> = {}) {
  return {
    userId: "user-1",
    ipAddress: "1.2.3.4",
    userAgent: "test-agent",
    deviceFingerprint: "fp-1",
    ...overrides,
  };
}

describe("RedisSessionStore", () => {
  let redis: FakeRedis;
  let store: RedisSessionStore;

  beforeEach(() => {
    redis = new FakeRedis();
    store = new RedisSessionStore(redis, { maxConcurrentSessions: 3 });
  });

  it("creates a session with a unique random id", async () => {
    const s1 = await store.create(makeInput());
    const s2 = await store.create(makeInput());
    expect(s1.id).not.toBe(s2.id);
    expect(s1.id.length).toBeGreaterThan(20);
    expect(s1.userId).toBe("user-1");
    expect(s1.isElevated).toBe(false);
  });

  it("reads back a created session", async () => {
    const created = await store.create(makeInput());
    const fetched = await store.get(created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.deviceFingerprint).toBe("fp-1");
  });

  it("returns null for a nonexistent session", async () => {
    expect(await store.get("does-not-exist")).toBeNull();
  });

  it("extends lastAccessedAt on read when slidingTtl is enabled (default)", async () => {
    const created = await store.create(makeInput());
    await new Promise((r) => setTimeout(r, 5));
    const fetched = await store.get(created.id);
    expect(fetched!.lastAccessedAt >= created.lastAccessedAt).toBe(true);
  });

  it("rotates a session: new id, same user/data, marked elevated, old id invalidated", async () => {
    const original = await store.create(makeInput({ data: { role: "user" } }));
    const rotated = await store.rotate(original.id);

    expect(rotated).not.toBeNull();
    expect(rotated!.id).not.toBe(original.id);
    expect(rotated!.userId).toBe(original.userId);
    expect(rotated!.data).toEqual({ role: "user" });
    expect(rotated!.isElevated).toBe(true);
    expect(rotated!.rotatedFrom).toBe(original.id);

    expect(await store.get(original.id)).toBeNull();
    expect(await store.get(rotated!.id)).not.toBeNull();
  });

  it("returns null when rotating a nonexistent session", async () => {
    expect(await store.rotate("nope")).toBeNull();
  });

  it("invalidates a single session and removes it from the user's active set", async () => {
    const s = await store.create(makeInput());
    await store.invalidate(s.id);
    expect(await store.get(s.id)).toBeNull();
    expect(await store.listActiveForUser("user-1")).toHaveLength(0);
  });

  it("invalidates all sessions for a user", async () => {
    const s1 = await store.create(makeInput());
    const s2 = await store.create(makeInput());
    const count = await store.invalidateAllForUser("user-1");

    expect(count).toBe(2);
    expect(await store.get(s1.id)).toBeNull();
    expect(await store.get(s2.id)).toBeNull();
  });

  it("enforces the concurrent session limit by evicting the oldest session", async () => {
    const s1 = await store.create(makeInput());
    await new Promise((r) => setTimeout(r, 2));
    await store.create(makeInput());
    await new Promise((r) => setTimeout(r, 2));
    await store.create(makeInput());
    await new Promise((r) => setTimeout(r, 2));
    const s4 = await store.create(makeInput()); // exceeds limit of 3, evicts s1

    expect(await store.get(s1.id)).toBeNull();
    expect(await store.get(s4.id)).not.toBeNull();
    expect(await store.listActiveForUser("user-1")).toHaveLength(3);
  });

  it("keeps sessions for different users independent for the concurrency cap", async () => {
    await store.create(makeInput({ userId: "user-a" }));
    await store.create(makeInput({ userId: "user-a" }));
    await store.create(makeInput({ userId: "user-a" }));

    const otherUserSession = await store.create(makeInput({ userId: "user-b" }));
    expect(otherUserSession).not.toBeNull();
    expect(await store.listActiveForUser("user-a")).toHaveLength(3);
  });
});
