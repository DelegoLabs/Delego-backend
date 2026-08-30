/**
 * Shared types for Redis Cluster caching (Issue #69).
 *
 * These mirror the data types specified in the issue so downstream
 * services can share one canonical shape for cache entries, invalidation
 * requests, cluster configuration, and metrics snapshots.
 */

/** Client-side configuration for connecting to a Redis Cluster. */
export interface RedisClusterConfig {
  nodes: Array<{ host: string; port: number }>;
  maxRedirections: number;
  retryStrategy: (times: number) => number;
  enableOfflineQueue: boolean;
  connectTimeout: number;
  commandTimeout: number;
}

/** A single cached value plus the metadata needed for invalidation and observability. */
export interface CacheEntry<T> {
  key: string;
  value: T;
  tags: string[];
  ttlSeconds: number;
  createdAt: string;
  hits: number;
}

/** A request to invalidate one or more cache entries. */
export interface CacheInvalidation {
  tags: string[];
  pattern?: string;
  mode: "exact" | "prefix" | "tag";
}

/** A point-in-time snapshot of cluster health and cache effectiveness. */
export interface ClusterMetrics {
  nodes: Array<{
    id: string;
    role: "master" | "replica";
    memoryUsed: number;
    memoryTotal: number;
    connectedClients: number;
    keyspaceHits: number;
    keyspaceMisses: number;
    latencyP99Ms: number;
  }>;
  totalKeys: number;
  hitRatio: number;
}
