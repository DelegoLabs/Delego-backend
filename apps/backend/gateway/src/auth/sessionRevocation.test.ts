import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  AUTH_SESSIONS_REVOKED_CHANNEL,
  hydrateUserSessionRevocations,
  isUserSessionRevoked,
  isUserSessionRevokedSync,
  markUserSessionsRevoked,
  resetSessionRevocationStateForTests,
  revokeRedisSessionsForUser,
  startSessionRevocationListener,
  stopSessionRevocationListener,
  type SessionRevocationRedisClient,
} from "./sessionRevocation.js";

function createFakeRedis() {
  const strings = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const published: Array<{ channel: string; message: string }> = [];
  const listeners = new Set<(channel: string, message: string) => void>();
  const scanCalls: Array<{ cursor: string; args: Array<string | number> }> = [];
  const deleted: string[] = [];

  const addKey = (key: string, value = "1") => strings.set(key, value);

  const redis: SessionRevocationRedisClient = {
    async scan(cursor, ...args) {
      scanCalls.push({ cursor, args });
      const pattern = args[1];
      const match = typeof pattern === "string" ? pattern : "*";
      const regex = new RegExp(
        "^" +
          match
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".") +
          "$",
      );
      const keys = [...strings.keys(), ...sets.keys()].filter((key) => regex.test(key));
      return ["0", keys];
    },
    pipeline() {
      const pending: string[] = [];
      return {
        del(...keys: string[]) {
          pending.push(...keys);
          return this;
        },
        async exec() {
          for (const key of pending) {
            deleted.push(key);
            strings.delete(key);
            sets.delete(key);
          }
          return pending.map((key) => [null, 1] as [Error | null, unknown]);
        },
      };
    },
    async publish(channel, message) {
      published.push({ channel, message });
      return 1;
    },
    async set(key, value) {
      strings.set(key, value);
      return "OK";
    },
    async get(key) {
      return strings.get(key) ?? null;
    },
    async subscribe() {
      return 1;
    },
    on(_event, listener) {
      listeners.add(listener);
      return redis;
    },
    async unsubscribe() {
      return 1;
    },
    async quit() {
      return "OK";
    },
  };

  return {
    redis,
    addKey,
    published,
    scanCalls,
    deleted,
    emit(channel: string, message: string) {
      for (const listener of listeners) listener(channel, message);
    },
  };
}

describe("sessionRevocation", () => {
  beforeEach(() => {
    resetSessionRevocationStateForTests();
  });

  it("scans session:{userId}:*, deletes matches via pipeline, and publishes revocation", async () => {
    const fake = createFakeRedis();
    fake.addKey("session:user-1:device-a");
    fake.addKey("session:user-1:device-b");
    fake.addKey("session:user-2:device-c");
    fake.addKey("session:user-10:device-d");

    const revokedAt = new Date("2026-01-02T03:04:05.000Z");
    const count = await revokeRedisSessionsForUser(
      "user-1",
      revokedAt,
      "security_compromise",
      fake.redis,
    );

    expect(count).toBe(2);
    expect(fake.deleted.sort()).toEqual([
      "session:user-1:device-a",
      "session:user-1:device-b",
    ]);
    expect(fake.scanCalls[0]).toMatchObject({
      cursor: "0",
      args: ["MATCH", "session:user-1:*", "COUNT", 500],
    });
    expect(fake.published).toHaveLength(1);
    expect(fake.published[0].channel).toBe(AUTH_SESSIONS_REVOKED_CHANNEL);
    expect(JSON.parse(fake.published[0].message)).toEqual({
      userId: "user-1",
      reason: "security_compromise",
      revokedAt: revokedAt.toISOString(),
      sessionsRevokedCount: 2,
    });
  });

  it("marks a JWT cutoff so older access tokens are rejected and newer ones allowed", async () => {
    const revokedAt = new Date("2026-01-02T03:04:05.000Z");
    markUserSessionsRevoked("user-1", revokedAt);

    expect(isUserSessionRevokedSync("user-1", Math.floor(revokedAt.getTime() / 1000))).toBe(true);
    expect(isUserSessionRevokedSync("user-1", Math.floor(revokedAt.getTime() / 1000) + 2)).toBe(false);
    expect(isUserSessionRevokedSync("user-2", 1)).toBe(false);
  });

  it("hydrates persisted revocation cutoffs from Redis", async () => {
    const fake = createFakeRedis();
    fake.addKey("auth:user-sessions-revoked:user-9", "2026-01-02T03:04:05.000Z");

    const loaded = await hydrateUserSessionRevocations(fake.redis);

    expect(loaded).toBe(1);
    expect(isUserSessionRevokedSync("user-9", Math.floor(Date.parse("2026-01-02T03:04:05.000Z") / 1000))).toBe(true);
  });

  it("async check consults the persisted Redis cutoff", async () => {
    const fake = createFakeRedis();
    fake.addKey("auth:user-sessions-revoked:user-7", "2026-01-02T03:04:05.000Z");

    await expect(isUserSessionRevoked("user-7", 1, fake.redis)).resolves.toBe(true);
    await expect(isUserSessionRevoked("user-7", 2_000_000_000, fake.redis)).resolves.toBe(false);
  });

  it("subscriber marks cutoffs from pub/sub messages", async () => {
    const fake = createFakeRedis();
    await startSessionRevocationListener(fake.redis);

    fake.emit(
      AUTH_SESSIONS_REVOKED_CHANNEL,
      JSON.stringify({
        userId: "user-8",
        reason: "password_reset",
        revokedAt: "2026-01-02T03:04:05.000Z",
      }),
    );

    expect(isUserSessionRevokedSync("user-8", Math.floor(Date.parse("2026-01-02T03:04:05.000Z") / 1000))).toBe(true);
    await stopSessionRevocationListener();
  });
});
