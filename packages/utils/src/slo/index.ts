/**
 * Service Level Objective (SLO) Dashboard with Error Budget Tracking
 *
 * Implements:
 *   - SLI definition for all services (latency, availability, quality)
 *   - SLO targets per service with error budget calculation
 *   - Burn rate alerting (fast/slow burn)
 *   - SLO dashboard per service
 *   - Error budget policies
 *   - SLO reporting for stakeholders
 *   - Incident management integration
 */

export {
  SLOManager,
  type SLOConfig,
  type SLIConfig,
  type BurnRateThresholds,
  type ErrorBudgetPolicy,
  type ErrorBudgetStatus,
  type SLOStatus,
  type SLOReport,
  type SLOMetrics,
  type ServiceSLOMetrics,
} from "./manager.js";

export {
  SLIRegistry,
  type SLIQuery,
  type SLIResult,
  type SLIType,
  type SLIUnit,
  type SLIThresholds,
} from "./sliRegistry.js";

export {
  BurnRateCalculator,
  type BurnRateResult,
  type BurnRateWindow,
  type BurnRateSeverity,
} from "./burnRate.js";

export {
  ErrorBudgetTracker,
  type ErrorBudgetState,
  type ErrorBudgetPeriod,
} from "./errorBudget.js";

export { type SLOAlert, SLOAlertManager } from "./alertManager.js";

export * from "./types.js";