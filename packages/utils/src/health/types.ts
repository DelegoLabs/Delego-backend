/**
 * Shared health-check data types (Issue #76)
 *
 * Mirrors the shapes requested in the issue:
 *   HealthCheck, ServiceHealth, HealthCheckConfig
 */

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthCheck {
  name: string;
  status: HealthStatus;
  latencyMs: number;
  details?: Record<string, unknown>;
  checkedAt: string;
}

export interface ServiceHealth {
  service: string;
  status: HealthStatus;
  checks: HealthCheck[];
  version: string;
  uptimeSeconds: number;
}

export type DependencyType = "database" | "redis" | "http" | "grpc" | "custom";

export interface DependencyConfig {
  name: string;
  type: DependencyType;
  config: Record<string, unknown>;
  critical: boolean;
}

export interface HealthCheckConfig {
  intervalSeconds: number;
  timeoutSeconds: number;
  failureThreshold: number;
  successThreshold: number;
  dependencies: DependencyConfig[];
}

export interface CheckResult {
  status?: HealthStatus;
  details?: Record<string, unknown>;
}

export type HealthCheckFn = () => Promise<CheckResult | void>;

export interface HealthMetrics {
  name: string;
  type: DependencyType;
  critical: boolean;
  status: HealthStatus;
  total: number;
  healthy: number;
  degraded: number;
  unhealthy: number;
  lastLatencyMs: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}
