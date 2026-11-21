/**
 * Cryptographic nonce cache preventing signature replay attacks (Issue #617).
 *
 * Stellar authorization envelopes and signed merchant requests carry a
 * transaction nonce. This module validates that a (account, nonce) pair has
 * never been seen before and that the request's timestamp is fresh, using a
 * Redis `SET key 1 EX ttl NX` as the atomic "claim this nonce" primitive —
 * the NX flag makes the claim succeed exactly once across any number of
 * concurrent/horizontally-scaled gateway instances, which an in-process
 * `Map` (see `apps/backend/gateway/middleware/requestSigning.ts`'s
 * `usedNonces`) cannot guarantee once there's more than one instance.
 *
 * This module is intentionally decoupled from `requestSigning.ts` — it's a
 * drop-in, horizontally-scalable replacement for that module's in-memory
 * nonce map, adoptable without changing the signature-verification logic
 * itself.
 */

import { createLogger } from "../logger.js";

const log = createLogger("utils:nonce-cache", process.env.LOG_LEVEL ?? "info");

/** Minimal subset of the ioredis/node-redis client API this module depends on. */
export interface NonceCacheRedisClient {
  /**
   * Must support ioredis-style variadic SET options. A successful claim
   * (key didn't already exist) returns `"OK"`; a replay (key already
   * exists) returns `null`.
   */
  set(
    key: string,
    value: string | number,
    ...args: Array<string | number>
  ): Promise<"OK" | null>;
}

export interface NonceValidationOptions {
  account: string;
  nonce: string;
  timestamp: number;
  ttlSeconds: number;
}

export type NonceRejectionReason = "stale_timestamp" | "replay";

export interface NonceValidationResult {
  valid: boolean;
  /** Present only when `valid` is false. */
  reason?: NonceRejectionReason;
  /** HTTP status a caller should respond with when `valid` is false. */
  httpStatus?: 400 | 409;
}

/** Default freshness window: +/- 60 seconds, per Issue #617's acceptance criteria. */
export const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 60;

const REDIS_KEY_PREFIX = "nonce-cache";

/** Builds the Redis key a given (account, nonce) pair claims. */
export function buildNonceCacheKey(account: string, nonce: string): string {
  return `${REDIS_KEY_PREFIX}:${account}:${nonce}`;
}

/**
 * Returns whether `timestamp` (epoch seconds) falls within
 * `toleranceSeconds` of the current time.
 */
export function isTimestampFresh(
  timestamp: number,
  toleranceSeconds: number = DEFAULT_TIMESTAMP_TOLERANCE_SECONDS
): boolean {
  if (!Number.isFinite(timestamp)) return false;
  const nowSeconds = Date.now() / 1000;
  return Math.abs(nowSeconds - timestamp) <= toleranceSeconds;
}

/**
 * Validates a nonce: rejects stale timestamps outright (no Redis round
 * trip needed), then atomically claims the nonce in Redis. A claim that
 * fails (the key already existed) means the nonce was already used —
 * a replay attempt.
 */
export async function validateNonce(
  redis: NonceCacheRedisClient,
  options: NonceValidationOptions,
  toleranceSeconds: number = DEFAULT_TIMESTAMP_TOLERANCE_SECONDS
): Promise<NonceValidationResult> {
  if (!isTimestampFresh(options.timestamp, toleranceSeconds)) {
    log.warn("Nonce rejected: stale timestamp", {
      account: options.account,
      timestamp: options.timestamp,
    });
    return { valid: false, reason: "stale_timestamp", httpStatus: 400 };
  }

  const key = buildNonceCacheKey(options.account, options.nonce);
  const ttl = Math.max(1, Math.floor(options.ttlSeconds));

  const claimed = await redis.set(key, 1, "EX", ttl, "NX");

  if (claimed !== "OK") {
    log.warn("Nonce rejected: replay detected", {
      account: options.account,
      nonce: options.nonce,
    });
    return { valid: false, reason: "replay", httpStatus: 409 };
  }

  return { valid: true };
}
