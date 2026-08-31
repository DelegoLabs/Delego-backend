/**
 * @delegolabs/cache — Redis Cluster client config, cache-aside helpers,
 * tag-based invalidation, and metrics collection (Issue #69).
 *
 * See docs/deployment/redis-cluster.md for the cluster topology,
 * Sentinel failover, backup/DR, and load-testing design this package's
 * client config is built to work against — none of which is deployed or
 * verified from this repo.
 */
export type { CacheRedisClient } from "./client.js";
export {
  getCacheClient,
  clusterConfigFromEnv,
  defaultRetryStrategy,
  disconnectCacheClient,
  _setCacheClientForTesting,
  _resetCacheClientForTesting,
} from "./client.js";

export {
  getOrSet,
  setCacheEntry,
  invalidate,
  getCacheStats,
  resetCacheStats,
  type GetOrSetOptions,
} from "./cacheAside.js";

export {
  collectClusterMetrics,
  mergeClusterMetrics,
  evaluateClusterHealth,
} from "./metrics.js";

export type {
  RedisClusterConfig,
  CacheEntry,
  CacheInvalidation,
  ClusterMetrics,
} from "./types.js";

export {
  redisLockAcquire,
  redisLockRelease,
  redisLockRenew,
  redisLockInspect,
  redisLockScan,
  workflowLockKey,
  stepLockKey,
  fenceKeyFor,
  serializeLockPayload,
  parseLockPayload,
  type RedisLockPayload,
  type RedisLockRenewResult,
} from "./lock.js";
