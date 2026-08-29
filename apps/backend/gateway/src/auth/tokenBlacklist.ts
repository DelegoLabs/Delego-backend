/**
 * Token revocation blacklist (Issue #77).
 *
 * Revoked access/refresh tokens are rejected via their `jti`. Entries are
 * kept in an in-memory cache for O(1) synchronous checks (< 10ms) and
 * mirrored to Redis so every gateway replica sees the revocation. Entries
 * auto-expire when the original token would have expired.
 */

import { getRedisClient } from "../rateLimit/redisClient.js";
import type { RevokedToken } from "./tokenTypes.js";

const REVOKED_KEY_PREFIX = "auth:revoked:";
const REVOKED_SET_KEY = "auth:revoked:set";

const memoryCache = new Map<string, RevokedToken>();

function serialize(entry: RevokedToken): string {
  return JSON.stringify(entry);
}

/** Removes expired entries from the in-memory cache. */
function pruneCache(): void {
  const now = Date.now();
  for (const [jti, entry] of memoryCache) {
    if (Date.parse(entry.expiresAt) <= now) {
      memoryCache.delete(jti);
    }
  }
}

function ttlSecondsFor(entry: RevokedToken): number {
  const ttlMs = Date.parse(entry.expiresAt) - Date.now();
  return ttlMs > 0 ? Math.max(1, Math.ceil(ttlMs / 1000)) : 1;
}

/**
 * Revoke a token. Updates the in-memory cache synchronously (so immediate
 * checks on this instance reject in < 10ms) and mirrors to Redis.
 */
export async function revokeToken(entry: RevokedToken): Promise<void> {
  pruneCache();
  memoryCache.set(entry.jti, entry);

  try {
    const redis = getRedisClient();
    await redis.set(
      `${REVOKED_KEY_PREFIX}${entry.jti}`,
      serialize(entry),
      "EX",
      ttlSecondsFor(entry),
    );
    await redis.sadd(REVOKED_SET_KEY, entry.jti);
  } catch {
    // Redis unavailable — the in-memory cache still enforces revocation
    // locally. Cross-instance revocation requires Redis to be up.
  }
}

/** Synchronous in-memory revocation check (O(1), no I/O). */
export function isTokenRevokedSync(jti?: string): boolean {
  if (!jti) return false;
  pruneCache();
  return memoryCache.has(jti);
}

/** Async check that also consults Redis (for cross-instance correctness). */
export async function isTokenRevoked(jti?: string): Promise<boolean> {
  if (!jti) return false;
  if (isTokenRevokedSync(jti)) return true;

  try {
    const redis = getRedisClient();
    const raw = await redis.get(`${REVOKED_KEY_PREFIX}${jti}`);
    return raw !== null;
  } catch {
    return false;
  }
}

/** Lists the tokens currently revoked on this instance. */
export function listRevokedTokens(): RevokedToken[] {
  pruneCache();
  return [...memoryCache.values()];
}

/** For tests: clear the local blacklist state. */
export function resetTokenBlacklist(): void {
  memoryCache.clear();
}
