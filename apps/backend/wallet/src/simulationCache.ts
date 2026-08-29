/**
 * Soroban Simulation Caching with Deduplication
 * Issue #141
 *
 * Features:
 * - Simulation result cache with TTL
 * - Cache invalidation on contract upgrades
 * - Cache warming for common transaction patterns
 * - Cache hit/miss metrics
 * - LRU eviction with configurable size limits
 * - Cache sharing across service instances via Redis
 * - Simulation deduplication for identical requests
 * - Cache bypass for simulation testing
 */

import { createHash } from "node:crypto";
import type { Transaction } from "@stellar/stellar-sdk";
import { Redis } from "ioredis";
// @ts-ignore
import MockRedis from "ioredis-mock";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("wallet:simulationCache", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SimulationCacheEntry {
  key: string;
  result: any;
  createdAt: string;
  expiresAt: string;
  hitCount: number;
  contractVersion: string;
}

export interface SimulationCacheConfig {
  maxEntries: number;
  ttlSeconds: number;
  warmupPatterns: Array<{
    contractId: string;
    method: string;
    sampleArgs: unknown[];
  }>;
  sharedCacheEnabled: boolean;
}

export interface SimulationCacheMetrics {
  hits: number;
  misses: number;
  hitRate: number;
  avgLatencyMs: number;
  cacheSize: number;
  evictions: number;
  deduplicated: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_KEY_PREFIX = "sim:cache:";
const CACHE_INDEX_KEY = "sim:cache:index";
const DEDUP_KEY_PREFIX = "sim:dedup:";
const METRICS_KEY = "sim:cache:metrics";
const WARMUP_KEY_PREFIX = "sim:warmup:";
const CONTRACT_VERSION_KEY_PREFIX = "sim:contract_version:";

const DEFAULT_CONFIG: SimulationCacheConfig = {
  maxEntries: 1000,
  ttlSeconds: 300, // 5 minutes
  warmupPatterns: [],
  sharedCacheEnabled: true,
};

// ---------------------------------------------------------------------------
// Internal State
// ---------------------------------------------------------------------------

let redisClient: Redis | null = null;
let config: SimulationCacheConfig = DEFAULT_CONFIG;
let localMetrics: {
  hits: number;
  misses: number;
  deduplicated: number;
  evictions: number;
  totalLatencyMs: number;
  totalRequests: number;
} = {
  hits: 0,
  misses: 0,
  deduplicated: 0,
  evictions: 0,
  totalLatencyMs: 0,
  totalRequests: 0,
};

// LRU tracking for local mode
const localCacheOrder: string[] = [];
const localCache = new Map<string, SimulationCacheEntry>();

// In-flight deduplication map
const inFlightRequests = new Map<string, Promise<any>>();

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function initSimulationCache(
  cacheConfig?: Partial<SimulationCacheConfig>,
  redis?: Redis
): void {
  config = { ...DEFAULT_CONFIG, ...cacheConfig };
  redisClient = redis ?? null;
  log.info("Simulation cache initialized", {
    maxEntries: config.maxEntries,
    ttlSeconds: config.ttlSeconds,
    sharedCacheEnabled: config.sharedCacheEnabled,
  });
}

export function getSimulationCacheMetrics(): SimulationCacheMetrics {
  const total = localMetrics.hits + localMetrics.misses;
  return {
    hits: localMetrics.hits,
    misses: localMetrics.misses,
    hitRate: total > 0 ? Number(((localMetrics.hits / total) * 100).toFixed(2)) : 0,
    avgLatencyMs: localMetrics.totalRequests > 0
      ? Number((localMetrics.totalLatencyMs / localMetrics.totalRequests).toFixed(2))
      : 0,
    cacheSize: localCache.size,
    evictions: localMetrics.evictions,
    deduplicated: localMetrics.deduplicated,
  };
}

// ---------------------------------------------------------------------------
// Cache Key Generation
// ---------------------------------------------------------------------------

function generateCacheKey(
  contractId: string,
  method: string,
  args: unknown[],
  footprint?: string
): string {
  const payload = JSON.stringify({ contractId, method, args, footprint });
  return createHash("sha256").update(payload).digest("hex");
}

function generateDedupKey(contractId: string, method: string, args: unknown[]): string {
  const payload = JSON.stringify({ contractId, method, args });
  return createHash("sha256").update(payload).digest("hex");
}

// ---------------------------------------------------------------------------
// Redis Cache Operations
// ---------------------------------------------------------------------------

async function getFromRedis(key: string): Promise<SimulationCacheEntry | null> {
  if (!redisClient || !config.sharedCacheEnabled) return null;

  try {
    const json = await redisClient.get(`${CACHE_KEY_PREFIX}${key}`);
    if (!json) return null;

    const entry = JSON.parse(json) as SimulationCacheEntry;
    const now = Date.now();
    if (new Date(entry.expiresAt).getTime() < now) {
      await redisClient.del(`${CACHE_KEY_PREFIX}${key}`);
      return null;
    }

    entry.hitCount++;
    await redisClient.set(`${CACHE_KEY_PREFIX}${key}`, JSON.stringify(entry), "EX", config.ttlSeconds);
    return entry;
  } catch (err) {
    log.warn("Redis cache read failed", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

async function setInRedis(key: string, entry: SimulationCacheEntry): Promise<void> {
  if (!redisClient || !config.sharedCacheEnabled) return;

  try {
    await redisClient.set(
      `${CACHE_KEY_PREFIX}${key}`,
      JSON.stringify(entry),
      "EX",
      config.ttlSeconds
    );

    await redisClient.zadd(
      CACHE_INDEX_KEY,
      Date.now(),
      key
    );

    const count = await redisClient.zcard(CACHE_INDEX_KEY);
    if (count > config.maxEntries) {
      const toEvict = await redisClient.zrange(CACHE_INDEX_KEY, 0, count - config.maxEntries - 1);
      if (toEvict.length > 0) {
        const pipeline = redisClient.pipeline();
        for (const evictKey of toEvict) {
          pipeline.del(`${CACHE_KEY_PREFIX}${evictKey}`);
          pipeline.zrem(CACHE_INDEX_KEY, evictKey);
        }
        await pipeline.exec();
        localMetrics.evictions += toEvict.length;
      }
    }
  } catch (err) {
    log.warn("Redis cache write failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------------------
// Local Cache Operations
// ---------------------------------------------------------------------------

function getFromLocal(key: string): SimulationCacheEntry | null {
  const entry = localCache.get(key);
  if (!entry) return null;

  if (new Date(entry.expiresAt).getTime() < Date.now()) {
    localCache.delete(key);
    const idx = localCacheOrder.indexOf(key);
    if (idx >= 0) localCacheOrder.splice(idx, 1);
    return null;
  }

  // Move to end (most recently used)
  const idx = localCacheOrder.indexOf(key);
  if (idx >= 0) localCacheOrder.splice(idx, 1);
  localCacheOrder.push(key);

  entry.hitCount++;
  return entry;
}

function setInLocal(key: string, entry: SimulationCacheEntry): void {
  localCache.set(key, entry);
  localCacheOrder.push(key);

  while (localCacheOrder.length > config.maxEntries) {
    const evictKey = localCacheOrder.shift()!;
    localCache.delete(evictKey);
    localMetrics.evictions++;
  }
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

async function checkDeduplication(dedupKey: string): Promise<any | null> {
  if (!redisClient || !config.sharedCacheEnabled) return null;

  try {
    const existing = await redisClient.get(`${DEDUP_KEY_PREFIX}${dedupKey}`);
    if (existing) {
      localMetrics.deduplicated++;
      return JSON.parse(existing);
    }
  } catch {}
  return null;
}

async function setDeduplication(dedupKey: string, result: any): Promise<void> {
  if (!redisClient || !config.sharedCacheEnabled) return;

  try {
    await redisClient.set(
      `${DEDUP_KEY_PREFIX}${dedupKey}`,
      JSON.stringify(result),
      "EX",
      30 // Short TTL for dedup
    );
  } catch {}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getCachedSimulation(
  contractId: string,
  method: string,
  args: unknown[],
  footprint?: string
): Promise<{ result: any; fromCache: boolean } | null> {
  if (process.env.SIM_CACHE_DISABLED === "true") {
    return null;
  }

  const key = generateCacheKey(contractId, method, args, footprint);
  const startTime = Date.now();

  // Check in-flight deduplication
  const dedupKey = generateDedupKey(contractId, method, args);
  const existingPromise = inFlightRequests.get(dedupKey);
  if (existingPromise) {
    try {
      const result = await existingPromise;
      localMetrics.deduplicated++;
      return { result, fromCache: true };
    } catch {
      return null;
    }
  }

  // Try local cache first
  const localEntry = getFromLocal(key);
  if (localEntry) {
    localMetrics.hits++;
    localMetrics.totalRequests++;
    localMetrics.totalLatencyMs += Date.now() - startTime;
    log.debug("Simulation cache hit (local)", { contractId, method });
    return { result: localEntry.result, fromCache: true };
  }

  // Try Redis cache
  const redisEntry = await getFromRedis(key);
  if (redisEntry) {
    localMetrics.hits++;
    localMetrics.totalRequests++;
    localMetrics.totalLatencyMs += Date.now() - startTime;
    setInLocal(key, redisEntry);
    log.debug("Simulation cache hit (redis)", { contractId, method });
    return { result: redisEntry.result, fromCache: true };
  }

  localMetrics.misses++;
  localMetrics.totalRequests++;
  localMetrics.totalLatencyMs += Date.now() - startTime;
  return null;
}

export async function setCachedSimulation(
  contractId: string,
  method: string,
  args: unknown[],
  result: any,
  footprint?: string,
  contractVersion?: string
): Promise<void> {
  if (process.env.SIM_CACHE_DISABLED === "true") {
    return;
  }

  const key = generateCacheKey(contractId, method, args, footprint);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.ttlSeconds * 1000);

  const entry: SimulationCacheEntry = {
    key,
    result,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    hitCount: 0,
    contractVersion: contractVersion ?? "unknown",
  };

  setInLocal(key, entry);
  await setInRedis(key, entry);

  // Set deduplication entry
  const dedupKey = generateDedupKey(contractId, method, args);
  await setDeduplication(dedupKey, result);

  // Remove from in-flight
  inFlightRequests.delete(dedupKey);

  log.debug("Simulation cached", { contractId, method, ttl: config.ttlSeconds });
}

export function setInFlightSimulation(
  contractId: string,
  method: string,
  args: unknown[],
  promise: Promise<any>
): void {
  const dedupKey = generateDedupKey(contractId, method, args);
  inFlightRequests.set(dedupKey, promise);
  promise.finally(() => {
    inFlightRequests.delete(dedupKey);
  });
}

// ---------------------------------------------------------------------------
// Cache Invalidation
// ---------------------------------------------------------------------------

export async function invalidateContractCache(
  contractId: string,
  redis?: Redis
): Promise<number> {
  const r = redis ?? redisClient;
  let invalidated = 0;

  if (r && config.sharedCacheEnabled) {
    try {
      const keys = await r.zrange(CACHE_INDEX_KEY, 0, -1);
      const pipeline = r.pipeline();

      for (const key of keys) {
        const entry = await r.get(`${CACHE_KEY_PREFIX}${key}`);
        if (entry) {
          const parsed = JSON.parse(entry);
          // Simple contract check via key pattern in result
          if (JSON.stringify(parsed.result).includes(contractId)) {
            pipeline.del(`${CACHE_KEY_PREFIX}${key}`);
            pipeline.zrem(CACHE_INDEX_KEY, key);
            invalidated++;
          }
        }
      }

      await pipeline.exec();
    } catch (err) {
      log.warn("Redis invalidation failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Invalidate local cache
  for (const [key, entry] of localCache.entries()) {
    if (JSON.stringify(entry.result).includes(contractId)) {
      localCache.delete(key);
      const idx = localCacheOrder.indexOf(key);
      if (idx >= 0) localCacheOrder.splice(idx, 1);
      invalidated++;
    }
  }

  log.info("Invalidated contract cache", { contractId, count: invalidated });
  return invalidated;
}

export async function invalidateAllCache(redis?: Redis): Promise<void> {
  const r = redis ?? redisClient;

  if (r && config.sharedCacheEnabled) {
    try {
      const keys = await r.zrange(CACHE_INDEX_KEY, 0, -1);
      const pipeline = r.pipeline();
      for (const key of keys) {
        pipeline.del(`${CACHE_KEY_PREFIX}${key}`);
      }
      pipeline.del(CACHE_INDEX_KEY);
      await pipeline.exec();
    } catch (err) {
      log.warn("Redis full invalidation failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  localCache.clear();
  localCacheOrder.length = 0;
  log.info("All simulation cache invalidated");
}

// ---------------------------------------------------------------------------
// Cache Warming
// ---------------------------------------------------------------------------

export async function warmupCache(
  warmPatterns: Array<{
    contractId: string;
    method: string;
    sampleArgs: unknown[];
  }>,
  simulateFn: (contractId: string, method: string, args: unknown[]) => Promise<any>
): Promise<{ warmed: number; failed: number }> {
  let warmed = 0;
  let failed = 0;

  for (const pattern of warmPatterns) {
    try {
      const cached = await getCachedSimulation(
        pattern.contractId,
        pattern.method,
        pattern.sampleArgs
      );

      if (!cached) {
        const result = await simulateFn(
          pattern.contractId,
          pattern.method,
          pattern.sampleArgs
        );
        await setCachedSimulation(
          pattern.contractId,
          pattern.method,
          pattern.sampleArgs,
          result
        );
        warmed++;
      } else {
        warmed++;
      }
    } catch (err) {
      failed++;
      log.warn("Cache warmup failed for pattern", {
        contractId: pattern.contractId,
        method: pattern.method,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("Cache warmup completed", { warmed, failed });
  return { warmed, failed };
}

export function setWarmupPatterns(
  patterns: Array<{
    contractId: string;
    method: string;
    sampleArgs: unknown[];
  }>
): void {
  config.warmupPatterns = patterns;
}

// ---------------------------------------------------------------------------
// Contract Version Tracking
// ---------------------------------------------------------------------------

export async function setContractVersion(
  contractId: string,
  version: string,
  redis?: Redis
): Promise<void> {
  const r = redis ?? redisClient;
  if (r && config.sharedCacheEnabled) {
    await r.set(`${CONTRACT_VERSION_KEY_PREFIX}${contractId}`, version);
  }
  await invalidateContractCache(contractId, r);
}

export async function getContractVersion(
  contractId: string,
  redis?: Redis
): Promise<string | null> {
  const r = redis ?? redisClient;
  if (r && config.sharedCacheEnabled) {
    return await r.get(`${CONTRACT_VERSION_KEY_PREFIX}${contractId}`);
  }
  return null;
}
