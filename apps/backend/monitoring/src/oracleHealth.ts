/**
 * Delivery Oracle Health Check & Heartbeat Monitor (Issue #299)
 *
 * Synthetic check verifying:
 *   - Carrier API response times
 *   - Webhook listener latency
 *   - Oracle key validity
 *
 * Exposes GET /health/oracle — returns 503 if the signing key is expired
 * or the carrier API is unreachable. Also alerts if no webhooks have been
 * received for > 6 hours during business hours.
 */

import { createLogger } from "@delegolabs/utils";

const log = createLogger("monitoring:oracleHealth", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OracleHealthReport {
  isOperational: boolean;
  carrierApiLatencyMs: number;
  lastWebhookReceivedAt: string;
  pendingDeliveriesCount: number;
  signingKeyValidUntil: string;
}

export interface OracleHealthStatus {
  healthy: boolean;
  report: OracleHealthReport;
  alerts: string[];
}

// ---------------------------------------------------------------------------
// In-memory heartbeat state
// (Replaced by a durable store in production)
// ---------------------------------------------------------------------------

let lastWebhookReceivedAt: Date | null = null;
let pendingDeliveriesCount = 0;

/**
 * Records that a delivery webhook was received. Call this from the webhook
 * ingestion handler so the heartbeat monitor can track webhook liveness.
 */
export function recordWebhookReceived(): void {
  lastWebhookReceivedAt = new Date();
}

/**
 * Updates the count of pending deliveries (deliveries awaiting confirmation).
 */
export function setPendingDeliveriesCount(count: number): void {
  pendingDeliveriesCount = count;
}

// ---------------------------------------------------------------------------
// Signing key validity
// ---------------------------------------------------------------------------

/**
 * Reads the oracle signing key expiry from the environment.
 * ORACLE_SIGNING_KEY_VALID_UNTIL should be an ISO-8601 timestamp.
 * Defaults to 30 days from now when not configured (dev fallback).
 */
function resolveSigningKeyValidUntil(): Date {
  const raw = process.env.ORACLE_SIGNING_KEY_VALID_UNTIL;
  if (raw) {
    const parsed = new Date(raw);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
    log.warn("ORACLE_SIGNING_KEY_VALID_UNTIL is set but not a valid ISO-8601 date; using dev fallback");
  }
  // Default dev fallback: 30 days from now
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
}

function isSigningKeyValid(validUntil: Date): boolean {
  return validUntil.getTime() > Date.now();
}

// ---------------------------------------------------------------------------
// Carrier API probe
// ---------------------------------------------------------------------------

const CARRIER_API_TIMEOUT_MS = 5_000;

/**
 * Probes the carrier API to measure latency. Returns latency in milliseconds
 * or null if the probe failed (unreachable / timeout).
 */
async function probeCarrierApi(): Promise<number | null> {
  const carrierApiUrl = process.env.CARRIER_API_PROBE_URL;
  if (!carrierApiUrl) {
    // No carrier API configured — treat as healthy in dev, but warn.
    log.debug("CARRIER_API_PROBE_URL is not configured; skipping carrier API probe");
    return 0;
  }

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CARRIER_API_TIMEOUT_MS);

  try {
    const response = await fetch(carrierApiUrl, {
      method: "GET",
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    });
    clearTimeout(timer);
    const latency = Date.now() - start;

    if (!response.ok) {
      log.warn("Carrier API probe returned non-2xx status", {
        status: response.status,
        url: carrierApiUrl,
        latencyMs: latency,
      });
      return null;
    }

    return latency;
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    log.warn("Carrier API probe failed", { url: carrierApiUrl, error: message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Business hours check
// ---------------------------------------------------------------------------

/**
 * Determines if the current UTC time falls within business hours.
 * Business hours are configurable via env:
 *   ORACLE_BUSINESS_HOURS_START (0–23, default: 8)
 *   ORACLE_BUSINESS_HOURS_END   (0–23, default: 18)
 *   ORACLE_BUSINESS_DAYS        (comma-separated 0=Sun…6=Sat, default: "1,2,3,4,5")
 */
function isBusinessHours(): boolean {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcDay = now.getUTCDay();

  const startHour = parseInt(process.env.ORACLE_BUSINESS_HOURS_START ?? "8", 10);
  const endHour = parseInt(process.env.ORACLE_BUSINESS_HOURS_END ?? "18", 10);
  const businessDays = (process.env.ORACLE_BUSINESS_DAYS ?? "1,2,3,4,5")
    .split(",")
    .map((d) => parseInt(d.trim(), 10))
    .filter((d) => !isNaN(d));

  return businessDays.includes(utcDay) && utcHour >= startHour && utcHour < endHour;
}

// ---------------------------------------------------------------------------
// Webhook latency alerting
// ---------------------------------------------------------------------------

/** Alert threshold: no webhooks for > 6 hours during business hours. */
const WEBHOOK_SILENCE_ALERT_THRESHOLD_MS = 6 * 60 * 60 * 1_000;

function checkWebhookSilenceAlert(): string | null {
  if (!isBusinessHours()) return null;

  if (!lastWebhookReceivedAt) {
    // No webhooks received since startup — alert if startup was > 6h ago.
    const uptimeMs = process.uptime() * 1_000;
    if (uptimeMs >= WEBHOOK_SILENCE_ALERT_THRESHOLD_MS) {
      return `No delivery webhooks received since service start (${Math.round(uptimeMs / 3_600_000)}h uptime)`;
    }
    return null;
  }

  const silenceMs = Date.now() - lastWebhookReceivedAt.getTime();
  if (silenceMs >= WEBHOOK_SILENCE_ALERT_THRESHOLD_MS) {
    const silenceHours = (silenceMs / 3_600_000).toFixed(1);
    return `No delivery webhooks received for ${silenceHours}h (last: ${lastWebhookReceivedAt.toISOString()})`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main health check
// ---------------------------------------------------------------------------

/**
 * Runs a full oracle health check:
 *   1. Probes the carrier API for latency.
 *   2. Checks oracle signing key validity.
 *   3. Checks webhook heartbeat silence during business hours.
 *
 * Returns a structured health status with `healthy: false` when:
 *   - The signing key is expired, OR
 *   - The carrier API is unreachable.
 */
export async function checkOracleHealth(): Promise<OracleHealthStatus> {
  const alerts: string[] = [];

  // 1. Carrier API probe
  const carrierApiLatencyMs = await probeCarrierApi();
  const carrierReachable = carrierApiLatencyMs !== null;

  if (!carrierReachable) {
    alerts.push("Carrier API is unreachable or timed out");
  }

  // 2. Signing key validity
  const signingKeyValidUntil = resolveSigningKeyValidUntil();
  const keyValid = isSigningKeyValid(signingKeyValidUntil);

  if (!keyValid) {
    alerts.push(`Oracle signing key expired at ${signingKeyValidUntil.toISOString()}`);
  } else {
    // Warn 7 days before expiry
    const daysUntilExpiry = (signingKeyValidUntil.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    if (daysUntilExpiry < 7) {
      alerts.push(
        `Oracle signing key expires in ${daysUntilExpiry.toFixed(1)} days (${signingKeyValidUntil.toISOString()})`
      );
    }
  }

  // 3. Webhook silence alert
  const silenceAlert = checkWebhookSilenceAlert();
  if (silenceAlert) {
    alerts.push(silenceAlert);
  }

  const isOperational = carrierReachable && keyValid;

  const report: OracleHealthReport = {
    isOperational,
    carrierApiLatencyMs: carrierApiLatencyMs ?? -1,
    lastWebhookReceivedAt: lastWebhookReceivedAt?.toISOString() ?? "",
    pendingDeliveriesCount,
    signingKeyValidUntil: signingKeyValidUntil.toISOString(),
  };

  if (!isOperational) {
    log.warn("Oracle health check failed", { alerts, report });
  }

  return { healthy: isOperational, report, alerts };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "@delegolabs/utils";

/**
 * GET /health/oracle
 *
 * Returns 200 with the health report when the oracle is operational.
 * Returns 503 if the signing key is expired or the carrier API is unreachable.
 */
export async function oracleHealthHandler(
  _req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    const status = await checkOracleHealth();
    const httpStatus = status.healthy ? 200 : 503;
    json(res, httpStatus, {
      data: {
        status: status.healthy ? "operational" : "degraded",
        ...status.report,
        alerts: status.alerts,
      },
      error: status.healthy
        ? null
        : {
            code: "ORACLE_UNHEALTHY",
            message: status.alerts.join("; "),
          },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Oracle health check failed";
    log.error("Oracle health check threw an unexpected error", { error: message });
    json(res, 503, {
      data: null,
      error: { code: "ORACLE_HEALTH_CHECK_ERROR", message },
    });
  }
}
