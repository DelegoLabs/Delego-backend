/**
 * Cryptographic Nonce Cache Preventing Signature Replay Attacks
 * 
 * Issue #617: Stellar authorization envelopes and signed merchant requests contain
 * transaction nonces. Tracks used nonces in Redis with atomic SET NX and enforces
 * +/- 60 seconds timestamp freshness windows.
 */

export interface NonceValidationOptions {
  account: string;
  nonce: string;
  timestamp: number;
  ttlSeconds: number;
}

export interface RedisLikeClient {
  set(key: string, value: string | number, ...args: any[]): Promise<any>;
}

export class NonceValidationError extends Error {
  public readonly statusCode: number;
  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.name = "NonceValidationError";
    this.statusCode = statusCode;
  }
}

export class StaleTimestampError extends NonceValidationError {
  constructor(message: string = "Stale timestamp: outside freshness window of +/- 60 seconds") {
    super(message, 400);
    this.name = "StaleTimestampError";
  }
}

export class ReplayedNonceError extends NonceValidationError {
  constructor(message: string = "Replayed nonce: nonce has already been used or cached") {
    super(message, 409);
    this.name = "ReplayedNonceError";
  }
}

/** Freshness window tolerance in seconds (+/- 60s) */
export const TIMESTAMP_FRESHNESS_WINDOW_SECONDS = 60;

/** Default key prefix for Redis nonce records */
export const NONCE_KEY_PREFIX = "nonce:";

/**
 * Builds the Redis storage key for a given account and nonce.
 */
export function buildNonceKey(account: string, nonce: string, prefix: string = NONCE_KEY_PREFIX): string {
  return `${prefix}${account}:${nonce}`;
}

/**
 * In-memory fallback nonce store implementing Redis SET NX semantics.
 */
export class InMemoryNonceStore implements RedisLikeClient {
  private store = new Map<string, number>();

  async set(key: string, value: string | number, ...args: any[]): Promise<string | null> {
    const now = Date.now();
    let ttlSec = 300;

    if (args[0] === "EX" && typeof args[1] === "number") {
      ttlSec = args[1];
    } else if (typeof args[0] === "object" && args[0]?.EX) {
      ttlSec = args[0].EX;
    }

    const existingExpiry = this.store.get(key);
    if (existingExpiry !== undefined && existingExpiry > now) {
      return null; // Key exists, NX check fails
    }

    this.store.set(key, now + ttlSec * 1000);
    return "OK";
  }

  clear(): void {
    this.store.clear();
  }
}

/**
 * Validates nonce freshness and uniqueness against a Redis client.
 * 
 * - Throws HTTP 400 (StaleTimestampError) if timestamp is outside +/- 60s.
 * - Throws HTTP 409 (ReplayedNonceError) if nonce is already present in cache.
 */
export async function validateNonce(
  redis: RedisLikeClient,
  options: NonceValidationOptions,
  nowMs: number = Date.now()
): Promise<boolean> {
  const { account, nonce, timestamp, ttlSeconds } = options;

  if (!account || !nonce) {
    throw new NonceValidationError("Account and nonce are required fields", 400);
  }

  // 1. Timestamp freshness validation (+/- 60 seconds)
  // Auto-detect seconds vs milliseconds
  const tsMs = timestamp > 1e11 ? timestamp : timestamp * 1000;
  const timeDifferenceMs = Math.abs(nowMs - tsMs);
  const maxAllowedDiffMs = TIMESTAMP_FRESHNESS_WINDOW_SECONDS * 1000;

  if (timeDifferenceMs > maxAllowedDiffMs) {
    throw new StaleTimestampError(
      `Timestamp ${timestamp} is outside allowable freshness window (+/- 60s, diff: ${Math.round(timeDifferenceMs / 1000)}s)`
    );
  }

  // 2. Redis atomic SET key 1 EX ttl NX check
  const key = buildNonceKey(account, nonce);
  const result = await redis.set(key, "1", "EX", ttlSeconds, "NX");

  if (!result || result === "NULL" || result === null) {
    throw new ReplayedNonceError(
      `Nonce "${nonce}" for account "${account}" was already used (HTTP 409 Conflict)`
    );
  }

  return true;
}
