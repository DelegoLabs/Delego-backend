/**
 * Redis client factory — cluster-aware config with a single-node/mocked
 * fallback for local dev and tests.
 *
 * IMPORTANT — scope note (Issue #69): this module builds and returns a
 * client that is *configured* for cluster awareness (topology discovery,
 * redirection handling, retry/backoff). It does not stand up Redis nodes,
 * Sentinel, or any cluster infrastructure — there is no live multi-node
 * Redis Cluster available in this environment to connect to or verify
 * against. Actual cluster deployment, Sentinel failover wiring, and the
 * throughput/failover acceptance criteria are covered as a design +
 * runbook document in docs/deployment/redis-cluster.md, not as code that
 * has been run against real infrastructure.
 */
import { Cluster, Redis, Sentinel } from "ioredis";
// @ts-ignore -- ioredis-mock has no first-party types
import MockRedis from "ioredis-mock";
import { createLogger } from "@delegolabs/utils";
import type { RedisClusterConfig, SentinelNodeConfig } from "./types.js";

const log = createLogger("cache:client", process.env.LOG_LEVEL ?? "info");

/** Minimal surface both `ioredis` Redis/Cluster clients and `ioredis-mock` satisfy. */
export interface CacheRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<"OK" | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number, nx: "NX"): Promise<"OK" | null>;
  set(key: string, value: string): Promise<"OK" | null>;
  del(...keys: string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  srem(key: string, ...members: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<number>;
  pttl(key: string): Promise<number>;
  scan(cursor: string | number, ...args: string[]): Promise<[string, string[]]>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  ping(): Promise<string>;
  quit(): Promise<"OK" | void>;
}

/** Default retry/backoff used when a caller does not supply one — capped exponential backoff. */
export function defaultRetryStrategy(times: number): number {
  if (times > 10) {
    // Give up signalling: ioredis stops retrying when the callback returns
    // a non-number in some versions; capping the delay is the portable form.
    return 2000;
  }
  return Math.min(times * 100, 2000);
}

/** Build a `RedisClusterConfig` from environment variables (comma-separated `host:port` list). */
export function clusterConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RedisClusterConfig {
  const nodesRaw = env.REDIS_CLUSTER_NODES ?? "localhost:6379";
  const nodes = nodesRaw.split(",").map((entry) => {
    const [host, portStr] = entry.trim().split(":");
    return { host, port: Number(portStr ?? 6379) };
  });

  return {
    nodes,
    maxRedirections: Number(env.REDIS_MAX_REDIRECTIONS ?? 16),
    retryStrategy: defaultRetryStrategy,
    enableOfflineQueue: env.REDIS_ENABLE_OFFLINE_QUEUE !== "false",
    connectTimeout: Number(env.REDIS_CONNECT_TIMEOUT_MS ?? 10_000),
    commandTimeout: Number(env.REDIS_COMMAND_TIMEOUT_MS ?? 5_000),
  };
}

/**
 * Parse Sentinel topology from environment variables (#401).
 *
 * Recognized variables:
 * - `REDIS_SENTINELS` — comma-separated `host:port` list (required to enable Sentinel)
 * - `REDIS_SENTINEL_MASTER` — master name (default `mymaster`)
 * - `REDIS_SENTINEL_ROLE` — `master` | `slave` (default `master`)
 * - `REDIS_PASSWORD` / `REDIS_USERNAME` — optional ACL credentials
 *
 * Returns `null` when `REDIS_SENTINELS` is unset so callers can fall back to
 * single-node or cluster mode.
 */
export function sentinelConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): SentinelNodeConfig | null {
  const sentinelsRaw = env.REDIS_SENTINELS?.trim();
  if (!sentinelsRaw) return null;

  const sentinels = sentinelsRaw.split(",").map((entry) => {
    const trimmed = entry.trim();
    const sep = trimmed.indexOf(":");
    if (sep <= 0 || sep === trimmed.length - 1) return null;
    const host = trimmed.slice(0, sep);
    const port = Number(trimmed.slice(sep + 1));
    if (!host || Number.isNaN(port) || port <= 0) return null;
    return { host, port };
  });

  if (sentinels.length === 0 || sentinels.some((s) => s === null)) {
    throw new Error(
      "REDIS_SENTINELS must be a comma-separated list of host:port entries"
    );
  }

  const role = env.REDIS_SENTINEL_ROLE === "slave" ? "slave" : "master";

  return {
    sentinels: sentinels as Array<{ host: string; port: number }>,
    masterName: env.REDIS_SENTINEL_MASTER ?? "mymaster",
    role,
    password: env.REDIS_PASSWORD || undefined,
    username: env.REDIS_USERNAME || undefined,
    sentinelTimeoutMs: Number(env.REDIS_SENTINEL_TIMEOUT_MS ?? 10_000),
    maxDiscoveryWaitMs: Number(env.REDIS_SENTINEL_MAX_WAIT_MS ?? 30_000),
  };
}

/** True when the process should connect through Sentinel rather than a fixed node. */
export function isSentinelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.REDIS_SENTINELS?.trim());
}

let sentinelClient: CacheRedisClient | null = null;

/**
 * Connect via Redis Sentinel, which auto-discovers the active master (and
 * optionally a replica) and reconnects across failover (#401).
 *
 * ioredis' `Sentinel` constructor watches topology changes: when the current
 * master is promoted away, the client reconnects to the new master using the
 * same master name. `enableOfflineQueue` keeps commands buffered during the
 * brief failover window.
 */
export function getSentinelClient(
  config: SentinelNodeConfig,
  env: NodeJS.ProcessEnv = process.env
): CacheRedisClient {
  if (sentinelClient) return sentinelClient;

  const role = config.role === "slave" ? "slave" : "master";
  log.info("Connecting cache client in Redis Sentinel mode", {
    masterName: config.masterName,
    role,
    sentinelCount: config.sentinels.length,
  });

  const client = new Sentinel(config.sentinels, {
    name: config.masterName,
    role,
    sentinelPassword: config.password,
    sentinelUsername: config.username,
    password: config.password,
    username: config.username,
    sentinels: config.sentinels,
    enableOfflineQueue: env.REDIS_ENABLE_OFFLINE_QUEUE !== "false",
    connectTimeout: config.sentinelTimeoutMs ?? 10_000,
    commandTimeout: Number(env.REDIS_COMMAND_TIMEOUT_MS ?? 5_000),
    retryStrategy: defaultRetryStrategy,
    // Failover reconnection: ioredis re-resolves the master via Sentinel.
    maxRetriesPerRequest: 3,
  }) as unknown as CacheRedisClient;

  // Surface failover events for ops without throwing on transient blips.
  const raw = client as unknown as NodeJS.EventEmitter;
  if (typeof raw.on === "function") {
    raw.on("error", (err: unknown) => {
      log.error("Redis Sentinel client error", { err });
    });
    raw.on("+master", (info: unknown) => {
      log.info("Redis Sentinel master changed", { info });
    });
  }

  sentinelClient = client;
  return client;
}

let client: CacheRedisClient | null = null;

function shouldUseMock(env: NodeJS.ProcessEnv): boolean {
  return (
    env.NODE_ENV === "test" ||
    env.MOCK_REDIS === "true" ||
    env.CI === "true"
  );
}

/**
 * Get or create the singleton cache client.
 *
 * - In tests/CI (or when `MOCK_REDIS=true`), returns an in-memory
 *   `ioredis-mock` instance so unit tests exercise real cache-aside/
 *   invalidation logic without a live Redis process.
 * - When `REDIS_CLUSTER_NODES` names more than one node, connects with
 *   `ioredis`'s `Cluster` client (client-side topology discovery,
 *   MOVED/ASK redirection handling per `maxRedirections`).
 * - Otherwise connects a single-node `Redis` client at `REDIS_URL`
 *   (or the first configured node) — this is what every environment in
 *   this sandbox and most local/dev setups use.
 */
export function getCacheClient(
  config: RedisClusterConfig = clusterConfigFromEnv(),
  env: NodeJS.ProcessEnv = process.env
): CacheRedisClient {
  if (client) return client;

  if (shouldUseMock(env)) {
    log.info("Using in-memory mock Redis client for cache module");
    const MockRedisConstructor = MockRedis as new () => CacheRedisClient;
    client = new MockRedisConstructor();
    return client;
  }

  // Sentinel auto-discovery takes priority when configured (#401).
  const sentinelConfig = sentinelConfigFromEnv(env);
  if (sentinelConfig) {
    client = getSentinelClient(sentinelConfig, env);
    return client;
  }

  if (config.nodes.length > 1) {
    log.info("Connecting cache client in cluster mode", {
      nodeCount: config.nodes.length,
    });
    client = new Cluster(config.nodes, {
      redisOptions: {
        connectTimeout: config.connectTimeout,
        commandTimeout: config.commandTimeout,
      },
      maxRedirections: config.maxRedirections,
      enableOfflineQueue: config.enableOfflineQueue,
      clusterRetryStrategy: config.retryStrategy,
    }) as unknown as CacheRedisClient;
  } else {
    const { host, port } = config.nodes[0] ?? { host: "localhost", port: 6379 };
    log.info("Connecting cache client in single-node mode", { host, port });
    client = new Redis({
      host,
      port,
      connectTimeout: config.connectTimeout,
      commandTimeout: config.commandTimeout,
      enableOfflineQueue: config.enableOfflineQueue,
      retryStrategy: config.retryStrategy,
    }) as unknown as CacheRedisClient;
  }

  return client;
}

/** Test-only seam: inject a fake/mock client instead of the singleton. */
export function _setCacheClientForTesting(testClient: CacheRedisClient): void {
  client = testClient;
}

/** Test-only seam: drop the singleton so the next call reconstructs it. */
export function _resetCacheClientForTesting(): void {
  client = null;
  sentinelClient = null;
}

/** Gracefully close the underlying connection, if one is open. */
export async function disconnectCacheClient(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
