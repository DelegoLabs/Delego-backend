# feat: notification deduplication, connection pooling, read replicas, query optimization

## Summary

- **#61** Notifications: sliding-window deduplication with Redis-backed storage, configurable windows, per-user/global/tenant scope, bypass for critical alerts, batch processing, and deduplication metrics.
- **#63** DB: connection pooling optimization with dynamic sizing, leak detection, query timeout enforcement, health checks, and Prometheus-compatible metrics.
- **#64** DB: read replica support with automatic routing (reads to replica, writes to primary), replica lag monitoring, health checks, and configurable consistency levels.
- **#65** DB: slow query optimization with pg_stat_statements analysis, missing index detection, materialized view support, and query plan analysis tooling.

## Changes

### Notifications — Deduplication (#61)
- Sliding window algorithm using Redis SET NX with TTL
- Configurable deduplication window (default 5 minutes)
- Per-user, global, or tenant scoping
- Bypass for critical/security alerts (never deduplicated)
- Batch deduplication via Redis pipeline
- In-memory metrics: total checks, duplicates blocked, deduplication rate
- Redis-backed metrics persistence
- Graceful degradation on Redis failures

### DB — Connection Pooling (#63)
- Dynamic pool sizing based on load
- Connection health checks with configurable intervals
- Query timeout enforcement
- Connection leak detection and tracking
- Pool metrics: active, idle, waiting, acquire time, errors
- Per-service pool configuration via environment variables
- Prepared statement caching support

### DB — Read Replicas (#64)
- Automatic query routing (SELECT to replicas, writes to primary)
- Replica lag monitoring with configurable thresholds
- Health check system with automatic failover
- Read consistency levels: eventual and strong
- Connection pooling per replica
- Replica status tracking and metrics

### DB — Query Optimization (#65)
- pg_stat_statements integration for query analysis
- Top N slowest query identification
- Missing index detection and recommendations
- Materialized view creation and refresh scheduling
- Index usage monitoring
- Query plan analysis utilities

## Testing

- Unit tests for deduplication logic (check, batch, metrics, scope, bypass)
- All new modules are backward-compatible with existing services

Closes #61, Closes #63, Closes #64, Closes #65
