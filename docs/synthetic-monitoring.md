# Synthetic Monitoring

This document describes the synthetic monitoring implementation for critical user journeys with global checkpoints.

## Overview

The synthetic monitoring module provides:

- **Multiple Check Types**: HTTP, Browser, DNS, TCP, SSL, WebSocket checks
- **Global Checkpoints**: 10+ regions with automatic location distribution
- **Check Scheduling**: Flexible scheduling with cron expressions
- **Alerting**: Configurable alerting on degradation and failures
- **Result Visualization**: Performance metrics and availability tracking
- **Maintenance Windows**: Support for scheduled maintenance periods
- **Status Page Integration**: Integration with status page services

## Data Structures

### SyntheticCheck

```typescript
interface SyntheticCheck {
  id: string;
  name: string;
  type: "http" | "browser" | "dns" | "tcp" | "ssl" | "websocket";
  frequency: number; // seconds
  locations: string[];
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    auth?: { type: string; credentials: string };
  };
  assertions: Assertion[];
  alerting: {
    enabled: boolean;
    threshold: number; // consecutive failures
    notifyOnRecovery: boolean;
  };
}
```

### CheckResult

```typescript
interface CheckResult {
  checkId: string;
  location: string;
  timestamp: string;
  status: "success" | "failed" | "degraded";
  responseTime: number;
  statusCode?: number;
  assertions: Array<{ passed: boolean; actual: string; expected: string }>;
  error?: string;
}
```

### SyntheticMetrics

```typescript
interface SyntheticMetrics {
  checkId: string;
  period: { start: string; end: string };
  availability: number;
  avgResponseTime: number;
  p95ResponseTime: number;
  byLocation: Record<string, { availability: number; avgResponseTime: number }>;
  incidents: Array<{ start: string; end?: string; duration: number; locations: string[] }>;
}
```

## Quick Start

### Basic Setup

```typescript
import { SyntheticMonitor } from "@delegolabs/utils";

const monitor = new SyntheticMonitor();

// The monitor comes with default checks already configured:
// - Gateway Health (10+ locations, every 60s)
// - Payments Checkout (10+ locations, every 120s)
// - Wallet Balance (10+ locations, every 120s)

// Run all checks
const results = await monitor.runAllChecks();

// Get metrics for a check
const metrics = monitor.generateMetrics("gateway-health", {
  start: new Date(Date.now() - 86400000).toISOString(),
  end: new Date().toISOString(),
});

console.log(metrics.availability); // 99.9%
console.log(metrics.avgResponseTime); // 45ms
```

### Custom Check Configuration

```typescript
const monitor = new SyntheticMonitor();

const customCheck: SyntheticCheck = {
  id: "custom-check",
  name: "Custom API Endpoint",
  type: "http",
  frequency: 60,
  locations: ["us-east-1", "us-west-2", "eu-west-1"],
  request: {
    url: "https://api.example.com/custom-endpoint",
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Authorization": "Bearer token",
    },
    body: JSON.stringify({ key: "value" }),
  },
  assertions: [
    { type: "status_code", operator: "eq", value: "200" },
    { type: "response_time", operator: "lt", value: "500" },
    { type: "body_contains", operator: "contains", value: "expected_value" },
    { type: "json_path", operator: "matches", value: "status.*ok" },
  ],
  alerting: {
    enabled: true,
    threshold: 3, // Alert after 3 consecutive failures
    notifyOnRecovery: true,
  },
};

monitor.addCheck(customCheck);
```

## Check Types

### HTTP Check

```typescript
{
  id: "http-check",
  name: "API Health",
  type: "http",
  frequency: 60,
  locations: ["us-east-1"],
  request: {
    url: "https://api.example.com/health",
    method: "GET",
    headers: { "Accept": "application/json" },
  },
  assertions: [
    { type: "status_code", operator: "eq", value: "200" },
  ],
  alerting: { enabled: true, threshold: 3, notifyOnRecovery: true },
}
```

### Browser Check

Simulates a browser visiting the page:

```typescript
{
  id: "browser-check",
  name: "Checkout Flow",
  type: "browser",
  frequency: 120,
  locations: ["us-east-1", "us-west-2"],
  request: {
    url: "https://example.com/checkout",
    method: "GET",
    headers: {},
  },
  assertions: [
    { type: "response_time", operator: "lt", value: "3000" }, // 3 seconds
  ],
  alerting: { enabled: true, threshold: 2, notifyOnRecovery: true },
}
```

### DNS Check

```typescript
{
  id: "dns-check",
  name: "DNS Resolution",
  type: "dns",
  frequency: 300, // 5 minutes
  locations: ["us-east-1"],
  request: {
    url: "https://api.example.com",
    method: "GET",
    headers: {},
  },
  assertions: [],
  alerting: { enabled: true, threshold: 2, notifyOnRecovery: true },
}
```

### TCP Check

```typescript
{
  id: "tcp-check",
  name: "Database Port",
  type: "tcp",
  frequency: 60,
  locations: ["us-east-1"],
  request: {
    url: "tcp://database.example.com:5432",
    method: "GET",
    headers: {},
  },
  assertions: [],
  alerting: { enabled: true, threshold: 3, notifyOnRecovery: true },
}
```

### SSL Check

```typescript
{
  id: "ssl-check",
  name: "SSL Certificate",
  type: "ssl",
  frequency: 3600, // 1 hour
  locations: ["us-east-1"],
  request: {
    url: "https://api.example.com",
    method: "GET",
    headers: {},
  },
  assertions: [
    { type: "certificate", operator: "eq", value: "valid" },
  ],
  alerting: { enabled: true, threshold: 1, notifyOnRecovery: true },
}
```

### WebSocket Check

```typescript
{
  id: "ws-check",
  name: "WebSocket Connection",
  type: "websocket",
  frequency: 120,
  locations: ["us-east-1"],
  request: {
    url: "wss://api.example.com/ws",
    method: "GET",
    headers: {},
  },
  assertions: [],
  alerting: { enabled: true, threshold: 2, notifyOnRecovery: true },
}
```

## Assertions

### Status Code

```typescript
{ type: "status_code", operator: "eq", value: "200" }
{ type: "status_code", operator: "neq", value: "500" }
{ type: "status_code", operator: "gt", value: "100" }
```

### Response Time

```typescript
{ type: "response_time", operator: "lt", value: "500" } // Less than 500ms
{ type: "response_time", operator: "gt", value: "100" } // Greater than 100ms
```

### Body Contains

```typescript
{ type: "body_contains", operator: "contains", value: "success" }
```

### JSON Path

```typescript
{ type: "json_path", operator: "contains", value: "data.user.id" }
{ type: "json_path", operator: "matches", value: "data.items.*" }
```

### Header

```typescript
{ type: "header", operator: "eq", value: "content-type" }
```

### Certificate

```typescript
{ type: "certificate", operator: "eq", value: "valid" }
```

## Scheduling

### Cron Expressions

```typescript
// Every minute
"* * * * *"

// Every 5 minutes
"*/5 * * * *"

// Every hour
"0 * * * *"

// Every day at midnight
"0 0 * * *"

// Every day at 6 AM
"0 6 * * *"

// Weekdays at 9 AM
"0 9 * * 1-5"
```

### Schedule Management

```typescript
import { CheckScheduler } from "@delegolabs/utils";

const scheduler = new CheckScheduler();

// Create schedule
const schedule = {
  id: "hourly-checks",
  name: "Hourly Checks",
  cron: "0 * * * *",
  checks: ["gateway-health", "payments-checkout"],
  timezone: "UTC",
};

scheduler.addSchedule(schedule);

// Add check to schedule
scheduler.addCheckToSchedule("hourly-checks", "wallet-balance");
```

## Maintenance Windows

```typescript
import { MaintenanceWindowManager } from "@delegolabs/utils";

const manager = new MaintenanceWindowManager();

// Add maintenance window
const window = {
  id: "maintenance-1",
  name: "Database Migration",
  startTime: "2025-09-01T02:00:00Z",
  endTime: "2025-09-01T04:00:00Z",
  checks: ["gateway-health", "payments-checkout"],
  reason: "Planned database migration",
  enabled: true,
};

manager.addWindow(window);

// Check if check is active
const isActive = manager.isCheckActive("gateway-health");
// Returns false during maintenance window
```

## Status Page Integration

```typescript
import { SyntheticMonitor, StatusPageIntegration } from "@delegolabs/utils";

const statusPage = new StatusPageIntegration({
  pageId: "your-page-id",
  apiKey: "your-api-key",
});

const monitor = new SyntheticMonitor({
  statusPage,
});

// Register checks
monitor.addCheck({
  id: "gateway-health",
  name: "Gateway Health",
  type: "http",
  frequency: 60,
  locations: ["us-east-1"],
  request: { url: "https://api.example.com/health", method: "GET", headers: {} },
  assertions: [{ type: "status_code", operator: "eq", value: "200" }],
  alerting: { enabled: true, threshold: 3, notifyOnRecovery: true },
});

// Status will be automatically updated
```

## Performance Benchmarks

```typescript
const benchmarks = monitor.getBenchmarks("gateway-health", "24h");

console.log(benchmarks);
// {
//   p50: 45,
//   p95: 85,
//   p99: 150,
//   avg: 55,
//   min: 20,
//   max: 500,
//   count: 1440,
//   timeWindow: "24h"
// }
```

## Metrics

```typescript
const metrics = monitor.generateMetrics("gateway-health", {
  start: new Date(Date.now() - 86400000).toISOString(),
  end: new Date().toISOString(),
});

console.log(metrics);
// {
//   availability: 0.999,
//   avgResponseTime: 45,
//   p95ResponseTime: 85,
//   byLocation: {
//     "us-east-1": { availability: 0.999, avgResponseTime: 45 },
//     "us-west-2": { availability: 0.998, avgResponseTime: 55 },
//   },
//   incidents: [...]
// }
```

## Alerting

### Consecutive Failure Threshold

```typescript
{
  alerting: {
    enabled: true,
    threshold: 3, // Alert after 3 consecutive failures
    notifyOnRecovery: true, // Notify when service recovers
  }
}
```

### Notifications

Integrate with your notification system:

```typescript
const monitor = new SyntheticMonitor();

// Override runCheck to add custom alerting
const originalRunCheck = monitor["runCheck"].bind(monitor);
monitor["runCheck"] = async (checkId: string, location?: string) => {
  const results = await originalRunCheck(checkId, location);
  
  // Check for failures
  const failures = results.filter((r) => r.status !== "success");
  if (failures.length > 0) {
    // Send alert
    await sendAlert(checkId, failures);
  }
  
  return results;
};
```

## Global Checkpoints

### Default Locations

The default configuration includes 10+ global regions:

| Region | Location |
|--------|----------|
| us-east-1 | US East (N. Virginia) |
| us-west-2 | US West (Oregon) |
| eu-west-1 | EU (Ireland) |
| eu-central-1 | EU (Frankfurt) |
| ap-south-1 | Asia Pacific (Mumbai) |
| ap-northeast-1 | Asia Pacific (Tokyo) |
| ap-southeast-1 | Asia Pacific (Singapore) |
| sa-east-1 | South America (Sao Paulo) |
| ca-central-1 | Canada (Central) |
| af-south-1 | Africa (Cape Town) |
| me-south-1 | Middle East (Bahrain) |
| eu-north-1 | EU (Stockholm) |

### Custom Locations

```typescript
const monitor = new SyntheticMonitor({
  locations: ["us-east-1", "eu-west-1", "ap-northeast-1"],
});
```

## Testing

```bash
# Run synthetic monitoring tests
pnpm test packages/utils/src/synthetic/*.test.ts
```

## Performance Benchmarks

### Expected Performance

| Metric | Target |
|--------|--------|
| Check execution time | < 5s |
| Response time p95 | < 500ms |
| Availability | > 99.9% |
| Check frequency | 60-300s |

### Monitoring

Track performance metrics:

```typescript
const metrics = monitor.generateMetrics("gateway-health", {
  start: new Date(Date.now() - 86400000).toISOString(),
  end: new Date().toISOString(),
});

console.log(`Availability: ${(metrics.availability * 100).toFixed(2)}%`);
console.log(`Avg Response Time: ${metrics.avgResponseTime.toFixed(0)}ms`);
console.log(`P95 Response Time: ${metrics.p95ResponseTime.toFixed(0)}ms`);
```

## Acceptance Criteria

### Checks from 10+ Global Locations ✅

```typescript
const monitor = new SyntheticMonitor();
const checks = monitor.listChecks();
expect(checks[0].locations.length).toBeGreaterThanOrEqual(10);
```

### Browser Checks for Critical Flows ✅

```typescript
monitor.addCheck({
  type: "browser",
  request: { url: "https://example.com/checkout" },
});
```

### Alerting on Degradation ✅

```typescript
{
  alerting: {
    enabled: true,
    threshold: 3,
    notifyOnRecovery: true,
  }
}
```

### Results in Grafana ✅

Metrics can be exported in Prometheus format for Grafana.

### Maintenance Windows Respected ✅

```typescript
const isActive = manager.isCheckActive("check-id");
// Returns false during maintenance windows
```

### Status Page Integration ✅

```typescript
new SyntheticMonitor({
  statusPage: new StatusPageIntegration({ pageId, apiKey }),
});
```