/**
 * Issue #150 — Circuit Breaker for webhook delivery.
 *
 * Implements the standard circuit breaker pattern (closed → open → half_open)
 * per webhook endpoint to prevent cascade failures when a downstream
 * webhook receiver is unhealthy.
 *
 * The circuit breaker:
 *  - Tracks failures per webhook endpoint
 *  - Opens the circuit after a configurable failure threshold
 *  - Transitions to half_open after a cooldown to probe recovery
 *  - Closes again after successful half_open requests
 *  - Persists state via a pluggable WebhookCircuitBreakerStore
 *
 * Manual control: operators can trip, reset, or force-open circuits via the
 * API endpoints exposed in the notifications service index.
 */

import { createLogger } from "@delegolabs/utils";

const log = createLogger(
  "notifications:webhook-circuit-breaker",
  process.env.LOG_LEVEL ?? "info"
);

// ─── Types ────────────────────────────────────────────────────────────────────

export type CircuitState = "closed" | "open" | "half_open";

export interface WebhookCircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeoutMs: number;
  halfOpenRequests: number;
}

export interface WebhookCircuitBreaker {
  webhookId: string;
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureAt?: string;
  lastStateChange: string;
  nextAttemptAt?: string;
  config: WebhookCircuitBreakerConfig;
}

export interface CircuitBreakerAction {
  webhookId: string;
  action: "trip" | "reset" | "force_open" | "force_closed";
  reason: string;
  performedBy: string;
}

export interface CircuitBreakerMetrics {
  webhookId: string;
  currentState: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  rejectedRequests: number;
  stateChanges: number;
  avgLatencyMs: number;
}

export interface WebhookCircuitBreakerStore {
  get(webhookId: string): Promise<WebhookCircuitBreaker | null>;
  set(breaker: WebhookCircuitBreaker): Promise<void>;
  getAll(): Promise<WebhookCircuitBreaker[]>;
}

// ─── Default config ───────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: WebhookCircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 3,
  timeoutMs: 30_000,
  halfOpenRequests: 3,
};

// ─── In-memory store (for testing / single-instance) ──────────────────────────

export class InMemoryCircuitBreakerStore implements WebhookCircuitBreakerStore {
  private store = new Map<string, WebhookCircuitBreaker>();

  async get(webhookId: string): Promise<WebhookCircuitBreaker | null> {
    return this.store.get(webhookId) ?? null;
  }

  async set(breaker: WebhookCircuitBreaker): Promise<void> {
    this.store.set(breaker.webhookId, breaker);
  }

  async getAll(): Promise<WebhookCircuitBreaker[]> {
    return Array.from(this.store.values());
  }
}

// ─── Core circuit breaker logic ───────────────────────────────────────────────

function getDefaultBreaker(webhookId: string): WebhookCircuitBreaker {
  return {
    webhookId,
    state: "closed",
    failureCount: 0,
    successCount: 0,
    lastStateChange: new Date().toISOString(),
    config: { ...DEFAULT_CONFIG },
  };
}

function evaluateState(
  breaker: WebhookCircuitBreaker
): CircuitState {
  if (breaker.state === "open" && breaker.nextAttemptAt) {
    if (Date.now() >= new Date(breaker.nextAttemptAt).getTime()) {
      return "half_open";
    }
  }
  return breaker.state;
}

/**
 * Records a successful delivery attempt.
 * In half_open state, increments success counter; if threshold reached,
 * transitions back to closed.
 */
export async function recordSuccess(
  store: WebhookCircuitBreakerStore,
  webhookId: string
): Promise<WebhookCircuitBreaker> {
  let breaker = (await store.get(webhookId)) ?? getDefaultBreaker(webhookId);
  breaker = { ...breaker };

  breaker.state = evaluateState(breaker);
  const now = new Date().toISOString();

  if (breaker.state === "half_open") {
    breaker.successCount++;
    if (breaker.successCount >= breaker.config.successThreshold) {
      log.info("Webhook circuit breaker closed — recovery confirmed", {
        webhookId,
        successCount: breaker.successCount,
      });
      breaker.state = "closed";
      breaker.failureCount = 0;
      breaker.successCount = 0;
      breaker.nextAttemptAt = undefined;
      breaker.lastStateChange = now;
    }
  } else if (breaker.state === "closed") {
    breaker.failureCount = 0;
  }

  await store.set(breaker);
  return breaker;
}

/**
 * Records a failed delivery attempt.
 * In closed state, increments failure counter; if threshold reached,
 * transitions to open with a cooldown.
 * In half_open state, immediately reopens the circuit.
 */
export async function recordFailure(
  store: WebhookCircuitBreakerStore,
  webhookId: string,
  errorMessage?: string
): Promise<WebhookCircuitBreaker> {
  let breaker = (await store.get(webhookId)) ?? getDefaultBreaker(webhookId);
  breaker = { ...breaker };

  breaker.state = evaluateState(breaker);
  const now = new Date();

  breaker.failureCount++;
  breaker.lastFailureAt = now.toISOString();

  if (breaker.state === "half_open") {
    log.warn("Webhook circuit breaker re-opened — test delivery failed", {
      webhookId,
      error: errorMessage,
    });
    breaker.state = "open";
    breaker.nextAttemptAt = new Date(
      now.getTime() + breaker.config.timeoutMs
    ).toISOString();
    breaker.lastStateChange = now.toISOString();
    breaker.successCount = 0;
  } else if (
    breaker.state === "closed" &&
    breaker.failureCount >= breaker.config.failureThreshold
  ) {
    log.warn("Webhook circuit breaker opened — failure threshold reached", {
      webhookId,
      failureCount: breaker.failureCount,
      threshold: breaker.config.failureThreshold,
    });
    breaker.state = "open";
    breaker.nextAttemptAt = new Date(
      now.getTime() + breaker.config.timeoutMs
    ).toISOString();
    breaker.lastStateChange = now.toISOString();
  }

  await store.set(breaker);
  return breaker;
}

/**
 * Returns the current state, transitioning from open to half_open
 * if the cooldown has elapsed.
 */
export async function getState(
  store: WebhookCircuitBreakerStore,
  webhookId: string
): Promise<CircuitState> {
  const breaker = (await store.get(webhookId)) ?? getDefaultBreaker(webhookId);
  const current = evaluateState(breaker);
  if (current !== breaker.state) {
    breaker.state = current;
    breaker.lastStateChange = new Date().toISOString();
    await store.set(breaker);
  }
  return current;
}

/**
 * Executes a function through the circuit breaker.
 * Rejects with CircuitBreakerOpenError if the circuit is open.
 */
export async function executeWithCircuitBreaker<T>(
  store: WebhookCircuitBreakerStore,
  webhookId: string,
  fn: () => Promise<T>
): Promise<T> {
  const state = await getState(store, webhookId);

  if (state === "open") {
    const breaker = (await store.get(webhookId)) ?? getDefaultBreaker(webhookId);
    throw new CircuitBreakerOpenError(webhookId, breaker.config.timeoutMs);
  }

  try {
    const result = await fn();
    await recordSuccess(store, webhookId);
    return result;
  } catch (err) {
    await recordFailure(
      store,
      webhookId,
      err instanceof Error ? err.message : String(err)
    );
    throw err;
  }
}

// ─── Error class ──────────────────────────────────────────────────────────────

export class CircuitBreakerOpenError extends Error {
  constructor(webhookId: string, cooldownMs: number) {
    super(
      `Circuit breaker for webhook "${webhookId}" is open. Retry after ${cooldownMs}ms.`
    );
    this.name = "CircuitBreakerOpenError";
  }
}

// ─── Manual control actions ───────────────────────────────────────────────────

export async function performAction(
  store: WebhookCircuitBreakerStore,
  action: CircuitBreakerAction
): Promise<WebhookCircuitBreaker> {
  let breaker =
    (await store.get(action.webhookId)) ??
    getDefaultBreaker(action.webhookId);
  breaker = { ...breaker };

  const now = new Date().toISOString();

  switch (action.action) {
    case "trip":
    case "force_open":
      breaker.state = "open";
      breaker.nextAttemptAt = new Date(
        Date.now() + breaker.config.timeoutMs
      ).toISOString();
      breaker.lastStateChange = now;
      log.info("Webhook circuit breaker force-opened", {
        webhookId: action.webhookId,
        reason: action.reason,
        performedBy: action.performedBy,
      });
      break;

    case "reset":
    case "force_closed":
      breaker.state = "closed";
      breaker.failureCount = 0;
      breaker.successCount = 0;
      breaker.nextAttemptAt = undefined;
      breaker.lastStateChange = now;
      log.info("Webhook circuit breaker reset to closed", {
        webhookId: action.webhookId,
        reason: action.reason,
        performedBy: action.performedBy,
      });
      break;
  }

  await store.set(breaker);
  return breaker;
}

// ─── Metrics collection ───────────────────────────────────────────────────────

export async function getMetrics(
  store: WebhookCircuitBreakerStore,
  webhookId: string,
  counters: {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    rejectedRequests: number;
    stateChanges: number;
    totalLatencyMs: number;
  }
): Promise<CircuitBreakerMetrics> {
  const breaker =
    (await store.get(webhookId)) ?? getDefaultBreaker(webhookId);

  return {
    webhookId,
    currentState: breaker.state,
    totalRequests: counters.totalRequests,
    successfulRequests: counters.successfulRequests,
    failedRequests: counters.failedRequests,
    rejectedRequests: counters.rejectedRequests,
    stateChanges: counters.stateChanges,
    avgLatencyMs:
      counters.totalRequests > 0
        ? counters.totalLatencyMs / counters.totalRequests
        : 0,
  };
}

// ─── Fallback delivery ────────────────────────────────────────────────────────

export type FallbackChannel = "email" | "sms" | "in_app";

export interface FallbackDeliveryConfig {
  /** Ordered list of fallback channels to try when webhook circuit is open. */
  fallbackChannels: FallbackChannel[];
}

/**
 * When the webhook circuit is open, attempts delivery via configured fallback
 * channels. Returns the first successful channel name, or throws if all fail.
 */
export async function deliverWithFallback(
  config: FallbackDeliveryConfig,
  deliverFn: (channel: FallbackChannel) => Promise<void>
): Promise<FallbackChannel> {
  for (const channel of config.fallbackChannels) {
    try {
      await deliverFn(channel);
      log.info("Fallback delivery succeeded", { channel });
      return channel;
    } catch (err) {
      log.warn("Fallback delivery failed, trying next channel", {
        channel,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  throw new Error("All fallback delivery channels failed");
}
