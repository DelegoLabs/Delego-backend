/**
 * Synthetic Monitoring Module
 *
 * Implements synthetic checks for critical user journeys with global checkpoints.
 * Features:
 *   - Multiple check types (HTTP, browser, DNS, TCP, SSL, WebSocket)
 *   - Global checkpoint configuration (10+ regions)
 *   - Check scheduling and alerting
 *   - Result visualization
 *   - Synthetic test scripts
 *   - Maintenance windows
 *   - Performance benchmarks
 *   - Status page integration
 */

export {
  SyntheticMonitor,
  type SyntheticCheck,
  type CheckResult,
  type SyntheticMetrics,
  type CheckType,
  type Assertion,
  type AssertionOperator,
  type AlertingConfig,
} from "./monitor.js";

export { CheckExecutor, type CheckOptions } from "./executor.js";

export { CheckScheduler, type Schedule } from "./scheduler.js";

export { CheckResultStore, type StoreOptions } from "./store.js";

export { StatusPageIntegration } from "./statusPage.js";

export { PerformanceBenchmarks } from "./benchmarks.js";

export { MaintenanceWindowManager } from "./maintenance.js";

export * from "./types.js";