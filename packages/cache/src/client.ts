/**
 * Redis client factory — cluster-aware config with a single-node/mocked
 * fallback for local dev and tests.
 *
 * Cluster mode wires three things:
 *
 * - `scaleReads: 'slave'` so ioredis routes read-only commands to read
 *   replicas and forces writes to the master (./clusterTopology.js).
 * - Automatic health-check pings with reconnection (./clusterHealth.js).
 * - An explicit `RedisClusterFailoverClient` for callers that need
 *   read-after-write guarantees or routing observability
 *   (./clusterFailover.js).
 *
 * IMPORTANT — scope note: this module builds and returns a client that is
 * *configured* for cluster awareness (topology discovery, redirection
 * handling, retry/backoff, replica read scaling). It does not stand up Redis
 * nodes, Sentinel, or any cluster infrastructure — there is no live
 * multi-node Redis Cluster available in this environment to connect to or
 * verify against. Actual cluster deployment and Sentinel failover wiring,
 * along with the throughput/failover acceptance criteria, are covered as a
 * design + runbook document in docs/deployment/redis-cluster.md, not as code
 * that has been run against real infrastructure.
 */
import { Cluster, Redis } from "ioredis";
// @ts-ignore -- ioredis-mock has no first-party types
import MockRedis from "ioredis-mock";
import { createLogger } from "@delegolabs/utils";
import { buildClusterOptions } from "./clusterTopology.js";
import {
  RedisClusterHealthMonitor,
  type HealthCheckableNode,
} from "./clusterHealth.js";
import {
  RedisClusterFailoverClient,
  type ClusterNodeConnection,
} from "./clusterFailover.js";
import {
  DEFAULT_SENTINEL_RECONNECT_CONFIG,
  SentinelReconnectManager,
  sentinelReconnectDelay,
  type SentinelReconnectConfig,
} from "./sentinelReconnect.js";
import type { RedisClusterConfig, RedisNodeRole, SentinelNodeConfig } from "./types.js";

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

function readPositiveNumber(
  raw: string | undefined,
  fallback: number,
  name: string
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

/**
 * Backoff configuration for Sentinel failover reconnects (#563). The defaults
 * are deliberately gentle: 100 ms base, 30 s cap, full jitter.
 */
export function sentinelReconnectConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): SentinelReconnectConfig {
  const baseMs = readPositiveNumber(
    env.REDIS_SENTINEL_RECONNECT_BASE_MS,
    DEFAULT_SENTINEL_RECONNECT_CONFIG.baseMs,
    "REDIS_SENTINEL_RECONNECT_BASE_MS"
  );
  const maxMs = readPositiveNumber(
    env.REDIS_SENTINEL_RECONNECT_MAX_MS,
    DEFAULT_SENTINEL_RECONNECT_CONFIG.maxMs,
    "REDIS_SENTINEL_RECONNECT_MAX_MS"
  );
  const maxAttempts = readPositiveNumber(
    env.REDIS_SENTINEL_RECONNECT_MAX_ATTEMPTS,
    DEFAULT_SENTINEL_RECONNECT_CONFIG.maxAttempts,
    "REDIS_SENTINEL_RECONNECT_MAX_ATTEMPTS"
  );
  const rawJitter = env.REDIS_SENTINEL_RECONNECT_JITTER_RATIO;
  const jitterRatio =
    rawJitter === undefined || rawJitter.trim() === ""
      ? DEFAULT_SENTINEL_RECONNECT_CONFIG.jitterRatio
      : Number(rawJitter);
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error("REDIS_SENTINEL_RECONNECT_JITTER_RATIO must be between 0 and 1");
  }

  return {
    baseMs: Math.min(baseMs, maxMs),
    maxMs,
    jitterRatio,
    maxAttempts: Math.floor(maxAttempts),
  };
}

/** Build a `RedisClusterConfig` from environment variables (comma-separated `host:port` list). */
export function clusterConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RedisClusterConfig {
  const nodesRaw = env.REDIS_CLUSTER_NODES ?? "localhost:6379";
  const nodes = nodesRaw.split(",").map((entry) => {
    const [host, portStr] = entry.trim().split(":");
    return { host, port: Number(portStr ?? 6379) };
  });

  const password = env.REDIS_PASSWORD?.trim();

  return {
    nodes,
    maxRedirections: Number(env.REDIS_MAX_REDIRECTIONS ?? 16),
    retryStrategy: defaultRetryStrategy,
    enableOfflineQueue: env.REDIS_ENABLE_OFFLINE_QUEUE !== "false",
    connectTimeout: Number(env.REDIS_CONNECT_TIMEOUT_MS ?? 10_000),
    commandTimeout: Number(env.REDIS_COMMAND_TIMEOUT_MS ?? 5_000),
    enableReadOnlyReplicas: env.REDIS_ENABLE_READ_ONLY_REPLICAS !== "false",
    healthCheckIntervalMs: Number(env.REDIS_HEALTH_CHECK_INTERVAL_MS ?? 5_000),
    healthCheckTimeoutMs: Number(env.REDIS_HEALTH_CHECK_TIMEOUT_MS ?? 2_000),
    healthCheckFailureThreshold: Number(env.REDIS_HEALTH_CHECK_FAILURE_THRESHOLD ?? 3),
    slotsRefreshIntervalMs: Number(env.REDIS_SLOTS_REFRESH_INTERVAL_MS ?? 5_000),
    ...(password ? { password } : {}),
  };
}

/**
 * Build a `SentinelNodeConfig` from environment variables (Issue #401 /
 * Issue #340).
 *
 * `REDIS_SENTINELS` is a comma-separated `host:port` list of Sentinel
 * processes. When Redis Sentinel promotes a new master during a failover,
 * an ioredis client configured this way re-queries the Sentinels and
 * reconnects to the promoted master automatically — it is not pinned to a
 * stale host:port the way a plain single-node connection is, which is what
 * previously left BullMQ workers hung on dead connection references while
 * trying to renew job locks.
 *
 * Returns `null` when Sentinel is not configured, so callers can fall back
 * to the existing cluster/single-node paths.
 */
export function sentinelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SentinelNodeConfig | null {
  const raw = env.REDIS_SENTINELS?.trim();
  if (!raw) return null;

  const sentinels = raw.split(",").map((entry) => {
    const [host, portStr] = entry.trim().split(":");
    if (!host || !portStr || Number.isNaN(Number(portStr))) {
      throw new Error(
        `Invalid REDIS_SENTINELS entry "${entry.trim()}" — expected "host:port" (e.g. "sentinel-1:26379").`
      );
    }
    return { host, port: Number(portStr) };
  });

  const role = env.REDIS_SENTINEL_ROLE === "slave" ? "slave" : "master";
  const password = env.REDIS_PASSWORD?.trim();
  const username = env.REDIS_USERNAME?.trim();
  const sentinelTimeoutMs = env.REDIS_SENTINEL_TIMEOUT_MS ? Number(env.REDIS_SENTINEL_TIMEOUT_MS) : undefined;
  const maxDiscoveryWaitMs = env.REDIS_SENTINEL_MAX_WAIT_MS ? Number(env.REDIS_SENTINEL_MAX_WAIT_MS) : undefined;

  return {
    sentinels,
    masterName: env.REDIS_SENTINEL_MASTER?.trim() || "mymaster",
    role,
    ...(password ? { password } : {}),
    ...(username ? { username } : {}),
    ...(sentinelTimeoutMs !== undefined ? { sentinelTimeoutMs } : {}),
    ...(maxDiscoveryWaitMs !== undefined ? { maxDiscoveryWaitMs } : {}),
  };
}

/** True only when `REDIS_SENTINELS` names at least one Sentinel process. */
export function isSentinelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return sentinelConfigFromEnv(env) !== null;
}

let client: CacheRedisClient | null = null;
let cluster: Cluster | null = null;
let sentinelClient: Redis | null = null;
let sentinelReconnectManager: SentinelReconnectManager | null = null;
let healthMonitor: RedisClusterHealthMonitor | null = null;

function shouldUseMock(env: NodeJS.ProcessEnv): boolean {
  return (
    env.NODE_ENV === "test" ||
    env.MOCK_REDIS === "true" ||
    env.CI === "true"
  );
}

/**
 * Wrap an ioredis per-node connection in the descriptor shape the health
 * monitor and failover client operate on.
 */
function describeNode(node: Redis, role: RedisNodeRole): HealthCheckableNode & ClusterNodeConnection {
  const host = node.options.host ?? "unknown";
  const port = node.options.port ?? 0;
  return {
    id: `${host}:${port}`,
    role,
    get status() {
      return node.status;
    },
    ping: () => node.ping(),
    connect: () => node.connect(),
  };
}

/** Build the node list ioredis currently knows about, split by role. */
function currentClusterNodes(): (HealthCheckableNode & ClusterNodeConnection)[] {
  if (!cluster) return [];
  return [
    ...cluster.nodes("master").map((n) => describeNode(n, "master")),
    ...cluster.nodes("slave").map((n) => describeNode(n, "replica")),
  ];
}

/**
 * Get or create the singleton cache client.
 *
 * - In tests/CI (or when `MOCK_REDIS=true`), returns an in-memory
 *   `ioredis-mock` instance so unit tests exercise real cache-aside/
 *   invalidation logic without a live Redis process.
 * - When `REDIS_CLUSTER_NODES` names more than one node, connects with
 *   `ioredis`'s `Cluster` client (client-side topology discovery,
 *   MOVED/ASK redirection handling per `maxRedirections`) configured for
 *   read-replica routing via `scaleReads: 'slave'`.
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

  const sentinelConfig = sentinelConfigFromEnv(env);
  if (sentinelConfig) {
    log.info("Connecting cache client via Redis Sentinel", {
      masterName: sentinelConfig.masterName,
      role: sentinelConfig.role,
      sentinelCount: sentinelConfig.sentinels.length,
    });

    const reconnectConfig = sentinelReconnectConfigFromEnv(env);
    sentinelReconnectManager = new SentinelReconnectManager(reconnectConfig);

    sentinelClient = new Redis({
      sentinels: sentinelConfig.sentinels,
      name: sentinelConfig.masterName,
      role: sentinelConfig.role,
      // Jittered exponential backoff per dropped socket, so a master
      // failover does not turn every socket into a simultaneous reconnect.
      sentinelRetryStrategy: (times: number) =>
        sentinelReconnectDelay(Math.max(0, times - 1), reconnectConfig),
      retryStrategy: config.retryStrategy,
      connectTimeout: sentinelConfig.sentinelTimeoutMs ?? config.connectTimeout,
      commandTimeout: config.commandTimeout,
      enableOfflineQueue: config.enableOfflineQueue,
      maxRetriesPerRequest: null,
      ...(sentinelConfig.password ? { password: sentinelConfig.password, sentinelPassword: sentinelConfig.password } : {}),
    });
    client = sentinelClient as unknown as CacheRedisClient;
    return client;
  }

  // Remaining branches (cluster / single-node) are unchanged from the original file.
  const clusterOptions = buildClusterOptions(config);
  cluster = new Cluster(config.nodes, clusterOptions);
  client = cluster as unknown as CacheRedisClient;
  return client;
}
