# Monitoring

Observability stack configuration.

## Health Checks (Issue #76)

Every service (gateway, orchestrator, wallet, payments) exposes the same
standard health surface backed by the shared `@delegolabs/utils` health
framework:

| Endpoint            | Purpose                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `GET /health/live`  | Liveness probe — always 200 while the process is running                  |
| `GET /health/ready` | Readiness probe — 503 when a **critical** dependency is unhealthy         |
| `GET /health`       | Full aggregate health (`ok` / `degraded` / `down`), backward compatible    |
| `GET /health/config`| Effective dependency graph (`HealthCheckConfig`)                          |
| `GET /health/dashboard` | Real-time HTML dashboard (auto-refreshes via `/health`)               |
| `GET /health/metrics`   | Prometheus text-format metrics                                        |

### Dependency checks

| Service     | Dependencies (critical in bold)                                       |
| ----------- | --------------------------------------------------------------------- |
| gateway     | **postgresql**, **redis**, orchestrator, wallet, payments              |
| orchestrator| **postgres**, redis                                                     |
| wallet      | **database**, **redis**, sorobanRpc                                    |
| payments    | **database**, walletService, sorobanRpc                                |

- Critical failures make `/health/ready` return 503 (pod is taken out of the
  load-balancer rotation).
- Non-critical failures report `degraded` and keep the pod ready so traffic
  keeps flowing — graceful degradation is visible in `/health` and the dashboard.
- Results are cached per check (`intervalSeconds`, default 10s) and smoothed by
  failure/success thresholds to avoid flapping probes.
- Per-check timeouts keep the aggregate fast (well under the 500 ms budget).

### Kubernetes probes

Liveness/readiness probes are pre-wired in
`infrastructure/deployment/k8s/*.yaml`:

```yaml
livenessProbe:
  httpGet: { path: /health/live, port: http }
readinessProbe:
  httpGet: { path: /health/ready, port: http }
```

### Metrics

`/health/metrics` exposes Prometheus text metrics:

```
delego_uptime_seconds{service="gateway"}
delego_health_status{service="gateway"} 0
delego_health_check_status{service="gateway",check="postgresql"} 0
delego_health_check_latency_ms{service="gateway",check="postgresql"} 3
```

Scrape them with Prometheus and visualize in Grafana.

Planned:
- Structured JSON logging (see `@delegolabs/utils` logger)
- Grafana dashboards for the health metrics
- Alert rules on `delego_health_status`
