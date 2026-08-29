# @delegolabs/cache

Redis Cluster client config, cache-aside helpers, and tag-based
invalidation for Delego backend services (Issue #69).

See [`docs/deployment/redis-cluster.md`](../../docs/deployment/redis-cluster.md)
for cluster topology, Sentinel failover, monitoring, and backup/DR — the
infrastructure this package's client is built to connect to, which has
not been deployed or load-tested from this repo.

```typescript
import { getCacheClient, getOrSet, invalidate } from "@delegolabs/cache";

const client = getCacheClient();

const product = await getOrSet(client, `product:${id}`, {
  ttlSeconds: 300,
  tags: ["products", `seller:${sellerId}`],
  loader: () => fetchProductFromDb(id),
});

// Evict every cached product tagged for this seller, e.g. after an update
await invalidate(client, { tags: [`seller:${sellerId}`], mode: "tag" });
```

## What's real vs. documented

- **Real, tested code:** `getCacheClient` (single-node and cluster-mode
  client construction from env), `getOrSet`/`setCacheEntry` (cache-aside
  pattern), `invalidate` (exact/prefix/tag eviction), and
  `collectClusterMetrics`/`evaluateClusterHealth` (metrics parsing +
  threshold checks). All covered by unit tests against `ioredis-mock`
  (`pnpm --filter @delegolabs/cache test`).
- **Documented, not deployed:** the actual 6-node cluster, Sentinel
  failover, cache warming automation, and backup/DR — see the deployment
  guide linked above. No live Redis Cluster was available to deploy or
  test against in this environment.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `REDIS_CLUSTER_NODES` | `localhost:6379` | Comma-separated `host:port` seed list |
| `REDIS_MAX_REDIRECTIONS` | `16` | MOVED/ASK redirects before failing |
| `REDIS_ENABLE_OFFLINE_QUEUE` | `true` | Queue commands while reconnecting |
| `REDIS_CONNECT_TIMEOUT_MS` | `10000` | Per-node connect timeout |
| `REDIS_COMMAND_TIMEOUT_MS` | `5000` | Per-command timeout |
| `MOCK_REDIS` / `NODE_ENV=test` / `CI=true` | — | Use an in-memory mock client instead of connecting |
