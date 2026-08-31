# SLO Dashboard Module

Service Level Objective (SLO) dashboard with error budget tracking and burn rate alerts.

## Overview

This module provides:

- **SLI Definitions**: Standardized Service Level Indicators for latency, availability, and quality
- **SLO Targets**: Configurable SLO targets per service with error budget calculation
- **Burn Rate Alerting**: Fast/slow burn detection with configurable thresholds
- **Dashboard APIs**: RESTful endpoints for service-specific SLO dashboards
- **Error Budget Policies**: Automated budget tracking and alerting
- **Incident Integration**: SLO alerts that integrate with incident management

## Installation

```bash
pnpm add ioredis prom-client
```

## Usage

### Basic Setup

```typescript
import { SLOManager } from "@delegolabs/utils";
import { SLOConfig } from "@delegolabs/utils";

const manager = new SLOManager();

// Register SLOs for a service
manager.registerServiceSLOs("gateway");

// Or register custom SLO
const sloConfig: SLOConfig = {
  id: "custom_slo",
  service: "gateway",
  name: "custom_sli",
  sliName: "custom_sli",
  target: 0.999,
  window: "rolling_24h",
  alerting: {
    burnRateThresholds: { warning: 2, critical: 6 },
  },
};

manager.registerSLO(sloConfig);
```

### Evaluate SLO

```typescript
const metrics = manager.evaluateSLO("slo_gateway_availability", 0.9995);

console.log(metrics);
// {
//   sloId: "slo_gateway_availability",
//   actual: 0.9995,
//   errorBudgetRemaining: 0.95,
//   burnRate: { "1h": 1.0, "6h": 1.1, "24h": 1.05 },
//   status: "healthy",
//   incidents: 0,
// }
```

### Get Service Metrics

```typescript
const metrics = manager.getServiceMetrics("gateway");

console.log(metrics);
// {
//   service: "gateway",
//   slos: [...],
//   overallHealth: "healthy",
//   lastUpdated: "2025-08-30T..."
// }
```

### Generate SLO Report

```typescript
const report = manager.generateSLOReport("gateway", {
  start: "2025-08-23T00:00:00Z",
  end: "2025-08-30T23:59:59Z",
});

console.log(report);
// {
//   service: "gateway",
//   period: { start: "...", end: "..." },
//   slos: [...],
//   overallHealth: "healthy",
// }
```

## SLI Definitions

### Availability SLIs

| Name | Description | Target |
|------|-------------|--------|
| `gateway_availability` | HTTP success rate for gateway | 99.9% |
| `payments_availability` | HTTP success rate for payments | 99.9% |
| `wallet_availability` | HTTP success rate for wallet | 99.9% |
| `notifications_availability` | HTTP success rate for notifications | 99.5% |

### Latency SLIs

| Name | Description | Target |
|------|-------------|--------|
| `gateway_p95_latency` | 95th percentile response latency | 200ms |
| `payments_p95_latency` | 95th percentile response latency | 300ms |
| `wallet_p95_latency` | 95th percentile response latency | 250ms |

### Quality SLIs

| Name | Description | Target |
|------|-------------|--------|
| `error_rate` | Rate of 5xx errors | 0.1% |
| `slow_requests_rate` | Requests under latency threshold | 99% |

### Throughput SLIs

| Name | Description | Target |
|------|-------------|--------|
| `gateway_throughput` | Requests per second | 1000 RPS |
| `payments_throughput` | Requests per second | 500 RPS |

## API Endpoints

### Dashboard Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/monitoring/slo/dashboard` | GET | Overall SLO status for all services |
| `/monitoring/slo/dashboard/:service` | GET | SLO status for specific service |
| `/monitoring/slo/report/:service` | GET | SLO report for period |

### Management Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/monitoring/slo` | POST | Create new SLO |
| `/monitoring/slo` | GET | List all SLOs |
| `/monitoring/slo/evaluate` | POST | Evaluate SLO status |
| `/monitoring/slo/:sloId/budget` | GET | Error budget state |

### Example: Get Service SLO Dashboard

```bash
# Get overall dashboard
curl -H "Authorization: Bearer <token>" \
  http://localhost:3000/monitoring/slo/dashboard

# Get gateway service dashboard
curl -H "Authorization: Bearer <token>" \
  http://localhost:3000/monitoring/slo/dashboard/gateway

# Get SLO report for last 7 days
curl -H "Authorization: Bearer <token>" \
  "http://localhost:3000/monitoring/slo/report/gateway?start=2025-08-23T00:00:00Z&end=2025-08-30T23:59:59Z"
```

## Burn Rate Alerting

### Thresholds

| Severity | 1h Burn Rate | 24h Burn Rate |
|----------|--------------|---------------|
| Warning | 2x | 2x |
| Critical | 6x | 6x |

### Burn Rate Calculation

```
Burn Rate = (1 - actual_availability) / (1 - target_availability)

Examples:
- Target: 99.9%, Actual: 99.9% → Burn Rate: 1.0x (on budget)
- Target: 99.9%, Actual: 99.5% → Burn Rate: ~4x (4x faster)
- Target: 99.9%, Actual: 99.0% → Burn Rate: ~10x (10x faster)
```

### Fast Burn Detection

Alerts when error budget is consumed rapidly (e.g., 20% in 10 minutes):

```
Fast Burn Alert: "Error budget burning 6x faster than allowed"
Severity: critical
```

### Slow Burn Detection

Alerts when budget is consumed consistently over time:

```
Slow Burn Alert: "Error budget will be exhausted in 23 days at current rate"
Severity: warning
```

## Error Budget Policies

### Default Policy

```typescript
{
  burnRateWarningThreshold: 2,
  burnRateCriticalThreshold: 6,
  burnRateWindow: "1h",
  autoRemediate: false,
  autoRemediateThreshold: 10,
  incidentAlertDelay: 5, // minutes
}
```

### Configuration

```typescript
const policies = {
  gateway_availability: {
    burnRateWarningThreshold: 3,
    burnRateCriticalThreshold: 8,
    burnRateWindow: "1h",
    autoRemediate: true,
    autoRemediateThreshold: 10,
    incidentAlertDelay: 10,
  },
};
```

## Monitoring Integration

### Prometheus Metrics

```promql
# SLO availability
1 - (sum(rate(http_requests_total{service="gateway",status=~"5.."}[1h])) / sum(rate(http_requests_total{service="gateway"}[1h])))

# Error budget consumed
sum(error_budget_consumed{service="gateway"})

# Burn rate
sum(burn_rate{service="gateway",window="1h"})
```

### Grafana Dashboard

```json
{
  "title": "SLO Dashboard",
  "panels": [
    {
      "title": "Error Budget Remaining",
      "expr": "error_budget_remaining{service=\"$service\"}",
      "type": "gauge"
    },
    {
      "title": "Burn Rate (1h)",
      "expr": "burn_rate{service=\"$service\",window=\"1h\"}",
      "type": "graph"
    },
    {
      "title": "SLO Availability",
      "expr": "slo_actual_availability{service=\"$service\"}",
      "type": "graph"
    }
  ]
}
```

## Testing

```bash
pnpm test packages/utils/src/slo/*.test.ts
```

## API Documentation

See `docs/slo-dashboard-ui.md` for UI component documentation.

## Migration Guide

### From Manual SLO Tracking

```typescript
// Before
const errorBudget = (1 - 0.999) * 86400; // 86.4 seconds
const consumed = errorBudget * (1 - actualAvailability / 0.999);

// After
const manager = new SLOManager();
manager.registerServiceSLOs("gateway");
const metrics = manager.evaluateSLO("slo_gateway_availability", actualAvailability);
const consumed = metrics.errorBudgetRemaining;
```