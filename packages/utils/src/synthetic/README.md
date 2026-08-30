# Synthetic Monitoring Module

Synthetic monitoring for critical user journeys with global checkpoints.

## Features

- Multiple check types (HTTP, Browser, DNS, TCP, SSL, WebSocket)
- 10+ global checkpoint regions
- Check scheduling with cron expressions
- Alerting on degradation and failures
- Result visualization and metrics
- Maintenance window support
- Status page integration

## Quick Start

```typescript
import { SyntheticMonitor } from "@delegolabs/utils";

const monitor = new SyntheticMonitor();

// Run checks
const results = await monitor.runAllChecks();

// Get metrics
const metrics = monitor.generateMetrics("gateway-health", {
  start: new Date(Date.now() - 86400000).toISOString(),
  end: new Date().toISOString(),
});

console.log(metrics.availability); // 99.9%
```

## Check Types

- **http**: HTTP request checks
- **browser**: Browser-based page checks
- **dns**: DNS resolution checks
- **tcp**: TCP port connectivity checks
- **ssl**: SSL certificate validation
- **websocket**: WebSocket connection checks

## API

### SyntheticMonitor

| Method | Description |
|--------|-------------|
| `addCheck(check)` | Add a new check |
| `getCheck(id)` | Get a check |
| `listChecks()` | List all checks |
| `removeCheck(id)` | Remove a check |
| `runCheck(id, location?)` | Run a single check |
| `runAllChecks(locations?)` | Run all checks |
| `generateMetrics(id, period)` | Generate metrics |
| `getBenchmarks(id, window)` | Get performance benchmarks |
| `getIncidents(id)` | Get incidents |
| `updateStatusPage()` | Update status page |

### CheckScheduler

| Method | Description |
|--------|-------------|
| `addSchedule(schedule)` | Add schedule |
| `updateSchedule(id, updates)` | Update schedule |
| `removeSchedule(id)` | Remove schedule |
| `startSchedule(id, execute)` | Start scheduled checks |
| `stopSchedule(id)` | Stop schedule |
| `executeSchedule(id, execute)` | Execute schedule |
| `getSchedulesForCheck(id)` | Get schedules for check |

### MaintenanceWindowManager

| Method | Description |
|--------|-------------|
| `addWindow(window)` | Add maintenance window |
| `updateWindow(id, updates)` | Update window |
| `removeWindow(id)` | Remove window |
| `isCheckActive(id, now?)` | Check if check is active |
| `getActiveWindows(now?)` | Get active windows |
| `isMaintenanceMode(id, now?)` | Check maintenance mode |

### StatusPageIntegration

| Method | Description |
|--------|-------------|
| `registerCheck(check)` | Register check for status page |
| `updateStatus(id, results)` | Update status page |
| `updateAllStatuses()` | Update all statuses |
| `createIncident(...)` | Create incident |
| `resolveIncident(id)` | Resolve incident |