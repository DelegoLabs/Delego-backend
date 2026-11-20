/**
 * User-wide session revocation (password reset / security compromise).
 *
 * Session keys live under `session:{userId}:*`. Revocation scans that
 * namespace, deletes the matches through a pipeline, publishes a
 * `auth:sessions:revoked` message for WebSocket servers, and records a
 * per-user cutoff timestamp so JWTs issued before the revocation are
 * rejected by gateway auth even though access tokens are stateless.
 */

import { Redis } from "ioredis";
import { createLogger } from "@delegolabs/utils";
import { getRedisClient } from "../rateLimit/redisClient.js";

const log = createLogger("gateway:session-revocation", process.env.LOG_LEVEL ?? "info");

export const AUTH_SESSIONS_REVOKED_CHANNEL = "auth:sessions:revoked";
const SESSION_KEY_PATTERN_PREFIX = "session:";
const USER_REVOCATION_KEY_PREFIX = "auth:user-sessions-revoked:";
const SCAN_COUNT = 500;
const DEFAULT_REVOCATION_TTL_SECONDS = 8 * 24 * 60 * 60;

export type SessionRevocationReason =
  | "password_reset"
  | "security_compromise"
  | "user_requested";

export interface RevokeAllSessionsRequest {
  userId: string;
  reason: SessionRevocationReason;
}

export interface RevokeAllSessionsResponse {
  sessionsRevokedCount: number;
  revokedAt: string;
}

export interface SessionRevocationMessage {
  userId: string;
  reason: SessionRevocationReason;
  revokedAt: string;
  sessionsRevokedCount?: number;
}

/** Minimal Redis surface used by session revocation. */
export interface SessionRevocationRedisClient {
  scan(
    cursor: string,
    ...args: Array<string | number>
  ): Promise<[string, string[]]>;
  pipeline(): {
    del(...keys: string[]): unknown;
    exec(): Promise<unknown>;
  };
  publish(channel: string, message: string): Promise<unknown>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  subscribe(channel: string): Promise<unknown>;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
  unsubscribe?(channel: string): Promise<unknown>;
  quit?(): Promise<unknown>;
}

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const revokedAtByUser = new Map<string, number>();
let commandClient: SessionRevocationRedisClient | null = null;
let subscriberClient: SessionRevocationRedisClient | null = null;
let subscriberClientOwned = false;
let subscriberStarted = false;

function isTestEnvironment(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.MOCK_REDIS === "true" ||
    process.env.CI === "true" ||
    Object.keys(process.env).some((key) => key.includes("TEST"))
  );
}

function getSessionRedisClient(): SessionRevocationRedisClient {
  // In tests the rate-limiter singleton is already backed by ioredis-mock;
  // production gets a dedicated connection so pub/sub subscriber mode on one
  // client can never break SCAN/DEL/PUBLISH on another.
  if (isTestEnvironment()) {
    return getRedisClient() as unknown as SessionRevocationRedisClient;
  }
  if (!commandClient) {
    commandClient = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    }) as unknown as SessionRevocationRedisClient;
  }
  return commandClient;
}

function createSubscriberClient(): SessionRevocationRedisClient {
  if (isTestEnvironment()) {
    return getRedisClient() as unknown as SessionRevocationRedisClient;
  }
  return new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  }) as unknown as SessionRevocationRedisClient;
}

function revocationTtlSeconds(): number {
  const parsed = Number(process.env.SESSION_REVOCATION_TTL_SECONDS);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_REVOCATION_TTL_SECONDS;
}

function userRevocationKey(userId: string): string {
  return `${USER_REVOCATION_KEY_PREFIX}${userId}`;
}

function parseRevokedAt(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Records the newest revocation cutoff for a user in memory. */
export function markUserSessionsRevoked(userId: string, revokedAt: Date): void {
  const ms = revokedAt.getTime();
  if (!Number.isFinite(ms)) return;
  const existing = revokedAtByUser.get(userId);
  if (existing === undefined || ms > existing) {
    revokedAtByUser.set(userId, ms);
  }
}

/**
 * Synchronous cutoff check used by request auth. JWT `iat` is second-granular,
 * so this fails closed for tokens whose issued-at second is not after the
 * revocation timestamp.
 */
export function isUserSessionRevokedSync(
  userId: string | undefined,
  issuedAtSeconds?: number,
): boolean {
  if (!userId) return false;
  const revokedAt = revokedAtByUser.get(userId);
  if (revokedAt === undefined) return false;
  if (issuedAtSeconds === undefined) return true;
  return issuedAtSeconds * 1000 <= revokedAt;
}

/** Async check that also consults the persisted Redis cutoff. */
export async function isUserSessionRevoked(
  userId: string | undefined,
  issuedAtSeconds?: number,
  redis: SessionRevocationRedisClient = getSessionRedisClient(),
): Promise<boolean> {
  if (isUserSessionRevokedSync(userId, issuedAtSeconds)) return true;
  if (!userId) return false;

  try {
    const persisted = parseRevokedAt(await redis.get(userRevocationKey(userId)));
    if (persisted === null) return false;
    markUserSessionsRevoked(userId, new Date(persisted));
    if (issuedAtSeconds === undefined) return true;
    return issuedAtSeconds * 1000 <= persisted;
  } catch (err) {
    log.warn("Failed to read persisted session revocation", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function scanKeys(redis: SessionRevocationRedisClient, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", SCAN_COUNT);
    keys.push(...batch);
    cursor = nextCursor;
  } while (cursor !== "0");
  return keys;
}

async function deleteKeysWithPipeline(
  redis: SessionRevocationRedisClient,
  keys: string[],
): Promise<number> {
  if (keys.length === 0) return 0;
  const pipeline = redis.pipeline();
  for (const key of keys) {
    pipeline.del(key);
  }
  const results = (await pipeline.exec()) as Array<[Error | null, unknown]> | null;
  if (!Array.isArray(results)) return keys.length;
  return results.reduce((total, [err, deleted]) => {
    if (err) return total;
    const count = Number(deleted);
    return total + (Number.isFinite(count) ? count : 0);
  }, 0);
}

/**
 * Deletes every `session:{userId}:*` key, records the revocation cutoff, and
 * publishes the pub/sub message WebSocket servers use to close connections.
 * Returns the number of session keys removed.
 */
export async function revokeRedisSessionsForUser(
  userId: string,
  revokedAt: Date = new Date(),
  reason: SessionRevocationReason = "user_requested",
  redis: SessionRevocationRedisClient = getSessionRedisClient(),
): Promise<number> {
  const pattern = `${SESSION_KEY_PATTERN_PREFIX}${userId}:*`;
  const keys = await scanKeys(redis, pattern);
  const sessionsRevokedCount = await deleteKeysWithPipeline(redis, keys);

  markUserSessionsRevoked(userId, revokedAt);
  await redis.set(
    userRevocationKey(userId),
    revokedAt.toISOString(),
    "EX",
    revocationTtlSeconds(),
  );

  const message: SessionRevocationMessage = {
    userId,
    reason,
    revokedAt: revokedAt.toISOString(),
    sessionsRevokedCount,
  };
  await redis.publish(AUTH_SESSIONS_REVOKED_CHANNEL, JSON.stringify(message));

  log.info("Revoked user sessions", {
    userId,
    sessionsRevokedCount,
    revokedAt: revokedAt.toISOString(),
  });
  return sessionsRevokedCount;
}

/** Publishes a revocation message with the caller-supplied reason. */
export async function publishSessionRevocation(
  message: SessionRevocationMessage,
  redis: SessionRevocationRedisClient = getSessionRedisClient(),
): Promise<void> {
  await redis.publish(AUTH_SESSIONS_REVOKED_CHANNEL, JSON.stringify(message));
}

function handleRevocationMessage(message: string): void {
  try {
    const parsed = JSON.parse(message) as Partial<SessionRevocationMessage>;
    if (typeof parsed.userId !== "string" || !parsed.userId) return;
    const revokedAt = typeof parsed.revokedAt === "string" ? new Date(parsed.revokedAt) : new Date();
    markUserSessionsRevoked(parsed.userId, revokedAt);
  } catch (err) {
    log.warn("Ignoring malformed session revocation message", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Loads persisted per-user revocation cutoffs into memory on startup. */
export async function hydrateUserSessionRevocations(
  redis: SessionRevocationRedisClient = getSessionRedisClient(),
): Promise<number> {
  const keys = await scanKeys(redis, `${USER_REVOCATION_KEY_PREFIX}*`);
  let loaded = 0;
  for (const key of keys) {
    const userId = key.slice(USER_REVOCATION_KEY_PREFIX.length);
    const revokedAt = parseRevokedAt(await redis.get(key));
    if (userId && revokedAt !== null) {
      markUserSessionsRevoked(userId, new Date(revokedAt));
      loaded += 1;
    }
  }
  if (loaded > 0) {
    log.info("Hydrated persisted session revocations", { loaded });
  }
  return loaded;
}

/**
 * Subscribes this gateway instance to `auth:sessions:revoked` so JWT cutoff
 * checks stay correct on every replica, not only the one that served the
 * revocation request.
 */
export async function startSessionRevocationListener(
  redis?: SessionRevocationRedisClient,
): Promise<void> {
  const client = redis ?? createSubscriberClient();
  const owned = !redis && !isTestEnvironment();
  await hydrateUserSessionRevocations(getSessionRedisClient());
  if (subscriberStarted) return;

  await client.subscribe(AUTH_SESSIONS_REVOKED_CHANNEL);
  client.on("message", (channel: string, message: string) => {
    if (channel === AUTH_SESSIONS_REVOKED_CHANNEL) {
      handleRevocationMessage(message);
    }
  });
  subscriberClient = client;
  subscriberClientOwned = owned;
  subscriberStarted = true;
  log.info("Session revocation listener started", {
    channel: AUTH_SESSIONS_REVOKED_CHANNEL,
  });
}

export async function stopSessionRevocationListener(): Promise<void> {
  const client = subscriberClient;
  const owned = subscriberClientOwned;
  subscriberClient = null;
  subscriberClientOwned = false;
  subscriberStarted = false;
  if (client) {
    try {
      await client.unsubscribe?.(AUTH_SESSIONS_REVOKED_CHANNEL);
    } catch {
      // Ignore unsubscribe errors during teardown.
    }
    if (owned) {
      try {
        await client.quit?.();
      } catch {
        // Ignore quit errors during teardown.
      }
    }
  }

  const command = commandClient;
  commandClient = null;
  if (command) {
    try {
      await command.quit?.();
    } catch {
      // Ignore quit errors during teardown.
    }
  }
}

/** Test helper: clears in-memory revocation state and injected clients. */
export function resetSessionRevocationStateForTests(): void {
  revokedAtByUser.clear();
  commandClient = null;
  subscriberClient = null;
  subscriberClientOwned = false;
  subscriberStarted = false;
}
