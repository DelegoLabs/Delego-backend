/**
 * Cluster metrics collection (Issue #69).
 *
 * Builds a `ClusterMetrics` snapshot from whatever node info the client
 * exposes. Against a real Redis Cluster this would fan out `CLUSTER NODES`
 * + `INFO` per node; ioredis-mock and single-node Redis don't expose
 * cluster topology, so this degrades to a single synthetic "node" entry
 * built from the one connection's own `INFO`/`DBSIZE`. This has NOT been
 * exercised against a real multi-node cluster — see
 * docs/deployment/redis-cluster.md for the monitoring/alerting design
 * that assumes real per-node `INFO` output.
 */
import type { CacheRedisClient } from "./client.js";
import type { ClusterMetrics } from "./types.js";

interface InfoCapableClient extends CacheRedisClient {
  info?(section?: string): Promise<string>;
  dbsize?(): Promise<number>;
}

function parseInfoField(info: string, field: string): number {
  const match = info.match(new RegExp(`^${field}:(.+)$`, "m"));
  return match ? Number(match[1].trim()) : 0;
}

/**
 * Collect a `ClusterMetrics` snapshot from the given client.
 *
 * `nodeId` lets callers label which physical/logical node this snapshot
 * came from when aggregating across a real cluster (e.g. call once per
 * node and merge the arrays); it defaults to "local" for the single-node/
 * mock case used in tests and local dev.
 */
export async function collectClusterMetrics(
  client: CacheRedisClient,
  nodeId = "local"
): Promise<ClusterMetrics> {
  const infoClient = client as InfoCapableClient;

  let memoryUsed = 0;
  let memoryTotal = 0;
  let connectedClients = 0;
  let keyspaceHits = 0;
  let keyspaceMisses = 0;
  let latencyP99Ms = 0;

  if (typeof infoClient.info === "function") {
    try {
      const info = await infoClient.info();
      memoryUsed = parseInfoField(info, "used_memory");
      memoryTotal = parseInfoField(info, "maxmemory") || memoryUsed;
      connectedClients = parseInfoField(info, "connected_clients");
      keyspaceHits = parseInfoField(info, "keyspace_hits");
      keyspaceMisses = parseInfoField(info, "keyspace_misses");
    } catch {
      // INFO isn't implemented by every mock/client — fall back to zeros
      // rather than failing metrics collection for the whole call.
    }
  }

  const start = Date.now();
  await client.ping();
  latencyP99Ms = Date.now() - start;

  let totalKeys = 0;
  if (typeof infoClient.dbsize === "function") {
    try {
      totalKeys = await infoClient.dbsize();
    } catch {
      totalKeys = 0;
    }
  }

  const totalOps = keyspaceHits + keyspaceMisses;
  const hitRatio = totalOps === 0 ? 0 : keyspaceHits / totalOps;

  return {
    nodes: [
      {
        id: nodeId,
        role: "master",
        memoryUsed,
        memoryTotal,
        connectedClients,
        keyspaceHits,
        keyspaceMisses,
        latencyP99Ms,
      },
    ],
    totalKeys,
    hitRatio,
  };
}

/** Merge per-node `ClusterMetrics` snapshots (one per real cluster node) into one report. */
export function mergeClusterMetrics(snapshots: ClusterMetrics[]): ClusterMetrics {
  const nodes = snapshots.flatMap((s) => s.nodes);
  const totalKeys = snapshots.reduce((sum, s) => sum + s.totalKeys, 0);
  const totalHits = nodes.reduce((sum, n) => sum + n.keyspaceHits, 0);
  const totalMisses = nodes.reduce((sum, n) => sum + n.keyspaceMisses, 0);
  const totalOps = totalHits + totalMisses;

  return {
    nodes,
    totalKeys,
    hitRatio: totalOps === 0 ? 0 : totalHits / totalOps,
  };
}

/**
 * Evaluate metrics against the acceptance thresholds named in Issue #69
 * (hit ratio > 95%, memory < 80% per node). This is a pure function over
 * an already-collected snapshot — it does not itself verify a live
 * cluster meets these thresholds under production load; that requires
 * the load-testing/monitoring runbook in docs/deployment/redis-cluster.md.
 */
export function evaluateClusterHealth(metrics: ClusterMetrics): {
  healthy: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];

  if (metrics.hitRatio < 0.95 && metrics.totalKeys > 0) {
    warnings.push(`Hit ratio ${(metrics.hitRatio * 100).toFixed(1)}% is below the 95% target`);
  }

  for (const node of metrics.nodes) {
    if (node.memoryTotal > 0) {
      const usedRatio = node.memoryUsed / node.memoryTotal;
      if (usedRatio >= 0.8) {
        warnings.push(
          `Node ${node.id} memory usage ${(usedRatio * 100).toFixed(1)}% is at/above the 80% threshold`
        );
      }
    }
  }

  return { healthy: warnings.length === 0, warnings };
}
