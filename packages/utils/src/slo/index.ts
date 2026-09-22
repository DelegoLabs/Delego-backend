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

export { SLOManager } from "./manager.js";
export { SLIRegistry } from "./sliRegistry.js";
export {
  BurnRateCalculator,
  type BurnRateWindow,
} from "./burnRate.js";
export { ErrorBudgetTracker } from "./errorBudget.js";
export { SLOAlertManager, type AlertType } from "./alertManager.js";
export * from "./types.js";
