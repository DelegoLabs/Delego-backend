/**
 * SLO Dashboard Types
 */

export interface SLI {
  name: string;
  description: string;
  query: string; // PromQL
  unit: "ratio" | "latency" | "throughput";
  goodThreshold: number;
  totalThreshold: number;
}

export interface SLO {
  id: string;
  service: string;
  name: string;
  sli: SLI;
  target: number; // 0-1 (e.g., 0.999)
  window: "rolling_1h" | "rolling_24h" | "rolling_7d" | "rolling_30d";
  alerting: {
    burnRateThresholds: Array<{
      window: string;
      threshold: number;
      severity: "warning" | "critical";
    }>;
  };
}

export interface ErrorBudget {
  sloId: string;
  period: { start: string; end: string };
  target: number;
  actual: number;
  budget: number;
  consumed: number;
  remaining: number;
  burnRate: {
    "1h": number;
    "6h": number;
    "24h": number;
  };
  status: "healthy" | "warning" | "critical" | "exhausted";
}

export interface SLOReport {
  service: string;
  period: { start: string; end: string };
  slos: Array<{
    name: string;
    target: number;
    actual: number;
    errorBudgetRemaining: number;
    burnRate: Record<string, number>;
    incidents: number;
  }>;
  overallHealth: "healthy" | "degraded" | "critical";
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal types for implementation
// ─────────────────────────────────────────────────────────────────────────────

export interface SLIConfig {
  name: string;
  description: string;
  query: string;
  unit: SLIUnit;
  thresholds: SLIThresholds;
}

export interface SLOConfig {
  id: string;
  service: string;
  name: string;
  sliName: string;
  target: number;
  window: SLOWindow;
  alerting: {
    burnRateThresholds: BurnRateThresholds;
  };
  policy?: ErrorBudgetPolicy;
}

export type SLIUnit = "ratio" | "latency" | "throughput";
export type SLOWindow = "rolling_1h" | "rolling_24h" | "rolling_7d" | "rolling_30d";
export type SLOStatus = "healthy" | "warning" | "critical" | "exhausted";

export interface BurnRateThresholds {
  warning: number;
  critical: number;
}

export interface ErrorBudgetPolicy {
  burnRateWarningThreshold: number;
  burnRateCriticalThreshold: number;
  burnRateWindow: string;
  autoRemediate: boolean;
  autoRemediateThreshold: number;
  incidentAlertDelay: number;
}

export interface SLOMetrics {
  sloId: string;
  service: string;
  sliName: string;
  target: number;
  window: SLOWindow;
  actual: number;
  errorBudgetRemaining: number;
  burnRate: Record<string, number>;
  status: SLOStatus;
  lastUpdated: string;
  incidents: number;
}

export interface ServiceSLOMetrics {
  service: string;
  slos: SLOMetrics[];
  overallHealth: "healthy" | "degraded" | "critical";
  lastUpdated: string;
}

export interface BurnRateResult {
  window: string;
  rate: number;
  severity: BurnRateSeverity;
}

export type BurnRateSeverity = "none" | "warning" | "critical";

export interface ErrorBudgetState {
  sloId: string;
  period: ErrorBudgetPeriod;
  target: number;
  actual: number;
  budget: number;
  consumed: number;
  remaining: number;
  burnRate: {
    "1h": number;
    "6h": number;
    "24h": number;
  };
  status: ErrorBudgetStatus;
}

export interface ErrorBudgetPeriod {
  start: string;
  end: string;
  window: SLOWindow;
}

export interface ErrorBudgetStatus {
  current: "healthy" | "warning" | "critical" | "exhausted";
  warningThreshold: number;
  criticalThreshold: number;
  exhaustedAt?: string;
}

export interface SLOAlert {
  id: string;
  sloId: string;
  service: string;
  type: "burn_rate_warning" | "burn_rate_critical" | "error_budget_critical" | "error_budget_exhausted";
  severity: "warning" | "critical";
  message: string;
  active: boolean;
  createdAt: string;
  resolvedAt?: string;
  metadata: Record<string, unknown>;
}

export interface SLIQuery {
  name: string;
  service: string;
  goodQuery: string;
  totalQuery: string;
}

export interface SLIResult {
  name: string;
  value: number;
  timestamp: string;
  labels: Record<string, string>;
}

export type SLIType = "availability" | "latency" | "quality" | "custom";