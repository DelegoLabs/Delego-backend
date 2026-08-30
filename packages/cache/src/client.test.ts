import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getCacheClient,
  clusterConfigFromEnv,
  defaultRetryStrategy,
  _resetCacheClientForTesting,
} from "./client.js";

describe("clusterConfigFromEnv", () => {
  it("parses a single-node default when REDIS_CLUSTER_NODES is unset", () => {
    const config = clusterConfigFromEnv({} as NodeJS.ProcessEnv);
    expect(config.nodes).toEqual([{ host: "localhost", port: 6379 }]);
  });

  it("parses a comma-separated multi-node list", () => {
    const config = clusterConfigFromEnv({
      REDIS_CLUSTER_NODES: "10.0.0.1:6379,10.0.0.2:6379,10.0.0.3:6379",
    } as NodeJS.ProcessEnv);

    expect(config.nodes).toEqual([
      { host: "10.0.0.1", port: 6379 },
      { host: "10.0.0.2", port: 6379 },
      { host: "10.0.0.3", port: 6379 },
    ]);
  });

  it("applies documented defaults for redirections/timeouts/offline queue", () => {
    const config = clusterConfigFromEnv({} as NodeJS.ProcessEnv);
    expect(config.maxRedirections).toBe(16);
    expect(config.connectTimeout).toBe(10_000);
    expect(config.commandTimeout).toBe(5_000);
    expect(config.enableOfflineQueue).toBe(true);
  });

  it("honors REDIS_ENABLE_OFFLINE_QUEUE=false", () => {
    const config = clusterConfigFromEnv({
      REDIS_ENABLE_OFFLINE_QUEUE: "false",
    } as NodeJS.ProcessEnv);
    expect(config.enableOfflineQueue).toBe(false);
  });
});

describe("defaultRetryStrategy", () => {
  it("backs off linearly up to the 2s cap", () => {
    expect(defaultRetryStrategy(1)).toBe(100);
    expect(defaultRetryStrategy(5)).toBe(500);
    expect(defaultRetryStrategy(30)).toBe(2000);
  });

  it("caps retries beyond 10 attempts at 2s rather than growing unbounded", () => {
    expect(defaultRetryStrategy(11)).toBe(2000);
    expect(defaultRetryStrategy(1000)).toBe(2000);
  });
});

describe("getCacheClient", () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    _resetCacheClientForTesting();
  });

  afterEach(() => {
    _resetCacheClientForTesting();
    process.env.NODE_ENV = originalEnv;
  });

  it("returns a mock client in test env and reuses the singleton", async () => {
    process.env.NODE_ENV = "test";
    const first = getCacheClient();
    const second = getCacheClient();

    expect(first).toBe(second);
    await first.set("k", "v");
    expect(await first.get("k")).toBe("v");
  });

  it("respects MOCK_REDIS=true outside of NODE_ENV=test", () => {
    process.env.NODE_ENV = "production";
    const client = getCacheClient(clusterConfigFromEnv(), {
      MOCK_REDIS: "true",
    } as NodeJS.ProcessEnv);
    expect(client).toBeDefined();
  });
});
