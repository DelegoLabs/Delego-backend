import { describe, it, expect } from "vitest";
// @ts-ignore -- ioredis-mock has no first-party types
import MockRedis from "ioredis-mock";
import { collectClusterMetrics, mergeClusterMetrics, evaluateClusterHealth } from "./metrics.js";
import type { CacheRedisClient } from "./client.js";
import type { ClusterMetrics } from "./types.js";

describe("collectClusterMetrics", () => {
  it("returns a single synthetic node snapshot for a non-cluster client", async () => {
    const client = new MockRedis() as unknown as CacheRedisClient;
    const metrics = await collectClusterMetrics(client, "node-a");

    expect(metrics.nodes).toHaveLength(1);
    expect(metrics.nodes[0].id).toBe("node-a");
    expect(metrics.nodes[0].role).toBe("master");
    expect(metrics.nodes[0].latencyP99Ms).toBeGreaterThanOrEqual(0);
  });

  it("does not throw when the client has no INFO/DBSIZE support", async () => {
    const bareClient: CacheRedisClient = {
      get: async () => null,
      set: (async () => "OK") as any,
      del: async () => 0,
      keys: async () => [],
      sadd: async () => 0,
      smembers: async () => [],
      srem: async () => 0,
      incr: async () => 0,
      expire: async () => 0,
      ping: async () => "PONG",
      quit: async () => "OK",
    };

    const metrics = await collectClusterMetrics(bareClient);
    expect(metrics.totalKeys).toBe(0);
    expect(metrics.hitRatio).toBe(0);
  });
});

describe("mergeClusterMetrics", () => {
  it("combines nodes and computes an aggregate hit ratio", () => {
    const a: ClusterMetrics = {
      nodes: [
        {
          id: "n1",
          role: "master",
          memoryUsed: 100,
          memoryTotal: 1000,
          connectedClients: 5,
          keyspaceHits: 80,
          keyspaceMisses: 20,
          latencyP99Ms: 1,
        },
      ],
      totalKeys: 500,
      hitRatio: 0.8,
    };
    const b: ClusterMetrics = {
      nodes: [
        {
          id: "n2",
          role: "replica",
          memoryUsed: 200,
          memoryTotal: 1000,
          connectedClients: 3,
          keyspaceHits: 20,
          keyspaceMisses: 80,
          latencyP99Ms: 2,
        },
      ],
      totalKeys: 300,
      hitRatio: 0.2,
    };

    const merged = mergeClusterMetrics([a, b]);
    expect(merged.nodes).toHaveLength(2);
    expect(merged.totalKeys).toBe(800);
    // 100 hits / 200 total ops = 0.5
    expect(merged.hitRatio).toBeCloseTo(0.5);
  });

  it("returns a zero-value report for an empty input", () => {
    const merged = mergeClusterMetrics([]);
    expect(merged.nodes).toEqual([]);
    expect(merged.totalKeys).toBe(0);
    expect(merged.hitRatio).toBe(0);
  });
});

describe("evaluateClusterHealth", () => {
  it("flags hit ratio below 95% when there are keys", () => {
    const metrics: ClusterMetrics = {
      nodes: [],
      totalKeys: 100,
      hitRatio: 0.9,
    };
    const result = evaluateClusterHealth(metrics);
    expect(result.healthy).toBe(false);
    expect(result.warnings[0]).toMatch(/Hit ratio/);
  });

  it("does not flag hit ratio when there are no keys yet (cold cache)", () => {
    const metrics: ClusterMetrics = { nodes: [], totalKeys: 0, hitRatio: 0 };
    const result = evaluateClusterHealth(metrics);
    expect(result.healthy).toBe(true);
  });

  it("flags a node at/above 80% memory usage", () => {
    const metrics: ClusterMetrics = {
      nodes: [
        {
          id: "n1",
          role: "master",
          memoryUsed: 850,
          memoryTotal: 1000,
          connectedClients: 1,
          keyspaceHits: 96,
          keyspaceMisses: 4,
          latencyP99Ms: 1,
        },
      ],
      totalKeys: 10,
      hitRatio: 0.96,
    };
    const result = evaluateClusterHealth(metrics);
    expect(result.healthy).toBe(false);
    expect(result.warnings.some((w) => w.includes("memory usage"))).toBe(true);
  });

  it("is healthy when hit ratio and memory are within thresholds", () => {
    const metrics: ClusterMetrics = {
      nodes: [
        {
          id: "n1",
          role: "master",
          memoryUsed: 400,
          memoryTotal: 1000,
          connectedClients: 1,
          keyspaceHits: 96,
          keyspaceMisses: 4,
          latencyP99Ms: 1,
        },
      ],
      totalKeys: 10,
      hitRatio: 0.96,
    };
    const result = evaluateClusterHealth(metrics);
    expect(result.healthy).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});
