import { createLogger } from "@delegolabs/utils";
import type { HSMKeySignerAdapter } from "./hsmSigner.js";

const log = createLogger("wallet:hsm-health", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HSMHealthStatus = "healthy" | "degraded" | "unavailable";

export interface HSMHealthCheck {
  status: HSMHealthStatus;
  latencyMs: number;
  lastCheck: string;
  lastError?: string;
  consecutiveFailures: number;
  uptime: number; // percentage over last 100 checks
}

export interface HSMAuditEntry {
  timestamp: string;
  operation: "sign" | "getPublicKey" | "health_check" | "key_rotation" | "key_provision";
  keyId: string;
  success: boolean;
  latencyMs?: number;
  error?: string;
  errorCode?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

interface CircuitBreakerState {
  failures: number;
  lastFailureTime: number;
  state: "closed" | "open" | "half-open";
}

const circuitBreakers = new Map<string, CircuitBreakerState>();

function getCircuitBreaker(keyId: string): CircuitBreakerState {
  let cb = circuitBreakers.get(keyId);
  if (!cb) {
    cb = { failures: 0, lastFailureTime: 0, state: "closed" };
    circuitBreakers.set(keyId, cb);
  }
  return cb;
}

/** Threshold before the circuit opens. */
const FAILURE_THRESHOLD = 5;
/** How long to stay open before trying half-open (ms). */
const OPEN_DURATION_MS = 60_000;

function recordFailure(keyId: string): void {
  const cb = getCircuitBreaker(keyId);
  cb.failures += 1;
  cb.lastFailureTime = Date.now();
  if (cb.failures >= FAILURE_THRESHOLD) {
    cb.state = "open";
    log.warn("HSM circuit breaker opened", { keyId, failures: cb.failures });
  }
}

function recordSuccess(keyId: string): void {
  const cb = getCircuitBreaker(keyId);
  cb.failures = 0;
  cb.state = "closed";
}

function isCircuitOpen(keyId: string): boolean {
  const cb = getCircuitBreaker(keyId);
  if (cb.state === "closed") return false;
  if (cb.state === "open" && Date.now() - cb.lastFailureTime > OPEN_DURATION_MS) {
    cb.state = "half-open";
    return false;
  }
  return cb.state === "open";
}

// ---------------------------------------------------------------------------
// Health monitor
// ---------------------------------------------------------------------------

interface HealthRecord {
  checks: boolean[];
  lastCheck: string;
  lastError?: string;
}

const healthRecords = new Map<string, HealthRecord>();

const MAX_CHECKS = 100;

function recordHealthCheck(keyId: string, success: boolean, error?: string): void {
  let record = healthRecords.get(keyId);
  if (!record) {
    record = { checks: [], lastCheck: "" };
    healthRecords.set(keyId, record);
  }
  record.checks.push(success);
  if (record.checks.length > MAX_CHECKS) {
    record.checks.shift();
  }
  record.lastCheck = new Date().toISOString();
  if (!success) {
    record.lastError = error;
  }
}

/**
 * Check HSM health by attempting to retrieve a public key.
 */
export async function checkHSMHealth(
  adapter: HSMKeySignerAdapter,
  keyId: string
): Promise<HSMHealthCheck> {
  const start = Date.now();
  let success = false;
  let error: string | undefined;

  try {
    await adapter.getPublicKey(keyId);
    success = true;
    recordSuccess(keyId);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    recordFailure(keyId);
  }

  const latencyMs = Date.now() - start;
  recordHealthCheck(keyId, success, error);

  const record = healthRecords.get(keyId);
  const checks = record?.checks ?? [];
  const successCount = checks.filter(Boolean).length;
  const uptime = checks.length > 0 ? (successCount / checks.length) * 100 : 0;

  let status: HSMHealthStatus = "healthy";
  if (!success) {
    status = isCircuitOpen(keyId) ? "unavailable" : "degraded";
  } else if (uptime < 95) {
    status = "degraded";
  }

  const result: HSMHealthCheck = {
    status,
    latencyMs,
    lastCheck: new Date().toISOString(),
    consecutiveFailures: getCircuitBreaker(keyId).failures,
    uptime,
  };
  if (error) result.lastError = error;

  log.info("HSM health check completed", { keyId, status, latencyMs, uptime: uptime.toFixed(1) });
  return result;
}

/**
 * Get the current health status without performing a check.
 */
export function getHSMHealthStatus(keyId: string): HSMHealthCheck | null {
  const record = healthRecords.get(keyId);
  if (!record) return null;

  const checks = record.checks;
  const successCount = checks.filter(Boolean).length;
  const uptime = checks.length > 0 ? (successCount / checks.length) * 100 : 0;
  const cb = getCircuitBreaker(keyId);

  let status: HSMHealthStatus = "healthy";
  if (cb.state === "open") {
    status = "unavailable";
  } else if (uptime < 95) {
    status = "degraded";
  }

  return {
    status,
    latencyMs: 0,
    lastCheck: record.lastCheck,
    lastError: record.lastError,
    consecutiveFailures: cb.failures,
    uptime,
  };
}

/**
 * Check if the HSM circuit breaker allows requests for a given key.
 */
export function isHSMAvailable(keyId: string): boolean {
  return !isCircuitOpen(keyId);
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

const auditEntries: HSMAuditEntry[] = [];
const MAX_AUDIT_ENTRIES = 10_000;

/**
 * Record an HSM audit event.
 */
export function recordHSMAudit(entry: Omit<HSMAuditEntry, "timestamp">): void {
  if (auditEntries.length >= MAX_AUDIT_ENTRIES) {
    auditEntries.shift();
  }
  auditEntries.push({ ...entry, timestamp: new Date().toISOString() });
  log.debug("HSM audit recorded", { operation: entry.operation, keyId: entry.keyId, success: entry.success });
}

/**
 * Retrieve audit entries, optionally filtered by keyId or operation.
 */
export function getHSMAuditTrail(filters?: {
  keyId?: string;
  operation?: HSMAuditEntry["operation"];
  since?: string;
  limit?: number;
}): HSMAuditEntry[] {
  let results = [...auditEntries];

  if (filters?.keyId) {
    results = results.filter((e) => e.keyId === filters.keyId);
  }
  if (filters?.operation) {
    results = results.filter((e) => e.operation === filters.operation);
  }
  if (filters?.since) {
    const sinceTime = new Date(filters.since).getTime();
    results = results.filter((e) => new Date(e.timestamp).getTime() >= sinceTime);
  }
  if (filters?.limit) {
    results = results.slice(-filters.limit);
  }

  return results;
}

/**
 * Clear audit trail (for testing).
 */
export function clearHSMAuditTrail(): void {
  auditEntries.length = 0;
}

/**
 * Clear circuit breaker state (for testing).
 */
export function clearCircuitBreakers(): void {
  circuitBreakers.clear();
}

/**
 * Clear all health state (for testing).
 */
export function clearHSMHealthState(): void {
  healthRecords.clear();
  circuitBreakers.clear();
  auditEntries.length = 0;
}
