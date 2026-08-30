/**
 * Synthetic Monitoring Types
 */

export type CheckType = "http" | "browser" | "dns" | "tcp" | "ssl" | "websocket";

export type AssertionOperator = "eq" | "neq" | "gt" | "lt" | "contains" | "matches";

export type AssertionType = 
  | "status_code"
  | "response_time"
  | "body_contains"
  | "json_path"
  | "header"
  | "certificate";

export type CheckStatus = "success" | "failed" | "degraded";

export interface Assertion {
  type: AssertionType;
  operator: AssertionOperator;
  value: string;
}

export interface SyntheticCheck {
  id: string;
  name: string;
  type: CheckType;
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

export interface CheckResult {
  checkId: string;
  location: string;
  timestamp: string;
  status: CheckStatus;
  responseTime: number;
  statusCode?: number;
  assertions: Array<{ passed: boolean; actual: string; expected: string }>;
  error?: string;
}

export interface SyntheticMetrics {
  checkId: string;
  period: { start: string; end: string };
  availability: number;
  avgResponseTime: number;
  p95ResponseTime: number;
  byLocation: Record<string, { availability: number; avgResponseTime: number }>;
  incidents: Array<{ start: string; end?: string; duration: number; locations: string[] }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

export interface CheckExecutionResult extends CheckResult {
  headers?: Record<string, string>;
  body?: string;
  sslInfo?: {
    valid: boolean;
    expiresAt?: string;
    issuer?: string;
  };
  dnsInfo?: {
    ips: string[];
    ttl?: number;
  };
}

export interface Schedule {
  id: string;
  name: string;
  cron: string;
  checks: string[];
  timezone: string;
}

export interface MaintenanceWindow {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  checks: string[];
  reason: string;
  enabled: boolean;
}

export interface Incident {
  id: string;
  checkId: string;
  location: string;
  startTime: string;
  endTime?: string;
  duration: number; // seconds
  failureCount: number;
  status: "active" | "resolved";
}

export interface PerformanceMetrics {
  checkId: string;
  location: string;
  p50: number;
  p95: number;
  p99: number;
  avg: number;
  min: number;
  max: number;
  count: number;
  timeWindow: string;
}