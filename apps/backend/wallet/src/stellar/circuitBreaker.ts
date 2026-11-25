/**
 * Soroban transaction circuit breaker — Issue #609.
 *
 * During heavy Horizon/Soroban RPC congestion, submitting transactions
 * repeatedly into an already-overloaded gateway just adds more backpressure
 * on top of backpressure. This module implements the classic
 * closed → open → half-open circuit breaker state machine around any async
 * Horizon/RPC call:
 *
 *   - `closed`     Calls pass straight through. Consecutive 502/503/504
 *                   responses are counted; once they hit `failureThreshold`
 *                   the circuit trips to `open`.
 *   - `open`       Every call is rejected immediately with
 *                   {@link CircuitOpenError} — Horizon is never contacted.
 *   - `half-open`  Entered automatically `resetTimeoutMs` after the trip. A
 *                   bounded number of trial calls (`halfOpenMaxAttempts`) are
 *                   allowed through. A successful trial closes the circuit; a
 *                   failing one re-opens it and restarts the reset timer.
 *
 * State transitions are emitted as Prometheus metrics via the shared
 * `ServiceMetricsRegistry` (see `apps/backend/wallet/src/index.ts`, which
 * wires one `ServiceMetricsRegistry` instance into the Soroban config) so
 * circuit flaps are visible on dashboards/alerts without extra plumbing.
 */

import type { ServiceMetricsRegistry } from "@delegolabs/utils";

export interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxAttempts: number;
}

export type CircuitState = "closed" | "open" | "half-open";

/** Per the issue spec: trips after 5 consecutive timeouts, 30s reset. */
export const DEFAULT_CIRCUIT_BREAKER_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxAttempts: 1,
};

/** HTTP status codes that count toward the breaker's trip threshold. */
const GATEWAY_FAILURE_STATUS_CODES = new Set([502, 503, 504]);

export interface CircuitBreakerDependencies {
  metricsRegistry?: ServiceMetricsRegistry;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Thrown by {@link SorobanCircuitBreaker.execute} when the circuit is open or has exhausted its half-open trial budget. */
export class CircuitOpenError extends Error {
  public readonly circuitName: string;
  public readonly state: CircuitState;

  constructor(circuitName: string, state: CircuitState, message: string) {
    super(message);
    this.name = "CircuitOpenError";
    this.circuitName = circuitName;
    this.state = state;
  }
}

/**
 * Extracts an HTTP status code from the shapes Horizon/Soroban RPC client
 * errors commonly take (`err.response.status`, `err.status`), falling back
 * to pattern-matching the error message for "504"/"gateway timeout" style
 * text when no structured status is available (some RPC/proxy errors only
 * surface a string).
 */
export function extractHttpStatus(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const withResponse = err as { response?: { status?: number }; status?: number };
    if (typeof withResponse.response?.status === "number") return withResponse.response.status;
    if (typeof withResponse.status === "number") return withResponse.status;
  }
  return undefined;
}

/** True when `err` represents a 502/503/504 gateway-style failure. */
export function isGatewayFailure(err: unknown): boolean {
  const status = extractHttpStatus(err);
  if (status !== undefined) return GATEWAY_FAILURE_STATUS_CODES.has(status);

  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return (
    /\b(502|503|504)\b/.test(message) ||
    /gateway timeout|bad gateway|service unavailable/i.test(message)
  );
}

interface CircuitBreakerStatus {
  name: string;
  state: CircuitState;
  consecutiveFailures: number;
  openedAt?: number;
  halfOpenAttemptsInFlight: number;
}

/**
 * One circuit breaker instance guards one logical upstream (e.g. "Horizon
 * submit", "Soroban RPC simulate"). Wrap any async call with `execute`:
 *
 * ```ts
 * const breaker = new SorobanCircuitBreaker("horizon-submit", {}, { metricsRegistry });
 * const result = await breaker.execute(() => rpcServer.sendTransaction(tx));
 * ```
 */
export class SorobanCircuitBreaker {
  private readonly options: CircuitBreakerOptions;
  private readonly metricsRegistry?: ServiceMetricsRegistry;
  private readonly now: () => number;

  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private halfOpenAttemptsInFlight = 0;

  constructor(
    private readonly name: string,
    options: Partial<CircuitBreakerOptions> = {},
    dependencies: CircuitBreakerDependencies = {},
  ) {
    this.options = { ...DEFAULT_CIRCUIT_BREAKER_OPTIONS, ...options };
    this.metricsRegistry = dependencies.metricsRegistry;
    this.now = dependencies.now ?? (() => Date.now());
  }

  get currentState(): CircuitState {
    this.maybeTransitionToHalfOpen();
    return this.state;
  }

  get failureCount(): number {
    return this.consecutiveFailures;
  }

  /**
   * Runs `fn` through the circuit breaker. Rejects immediately with
   * {@link CircuitOpenError} — without ever invoking `fn` — when the
   * circuit is `open`, or when it is `half-open` and already has
   * `halfOpenMaxAttempts` trial calls in flight.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeTransitionToHalfOpen();

    if (this.state === "open") {
      this.recordEvent("rejected");
      throw new CircuitOpenError(
        this.name,
        "open",
        `Circuit breaker "${this.name}" is open after ${this.consecutiveFailures} consecutive gateway failures; rejecting call without contacting Horizon`,
      );
    }

    if (this.state === "half-open") {
      if (this.halfOpenAttemptsInFlight >= this.options.halfOpenMaxAttempts) {
        this.recordEvent("rejected");
        throw new CircuitOpenError(
          this.name,
          "half-open",
          `Circuit breaker "${this.name}" is half-open and at its trial-attempt limit (${this.options.halfOpenMaxAttempts})`,
        );
      }
      this.halfOpenAttemptsInFlight += 1;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      throw err;
    } finally {
      if (this.state !== "closed") {
        this.halfOpenAttemptsInFlight = Math.max(0, this.halfOpenAttemptsInFlight - 1);
      }
    }
  }

  /** Opens → half-open transition is lazy: evaluated on every state read/execute. */
  private maybeTransitionToHalfOpen(): void {
    if (this.state === "open" && this.now() - this.openedAt >= this.options.resetTimeoutMs) {
      this.state = "half-open";
      this.halfOpenAttemptsInFlight = 0;
      this.recordStateGauge();
    }
  }

  private onSuccess(): void {
    if (this.state === "half-open") {
      this.close();
      return;
    }
    this.consecutiveFailures = 0;
  }

  private onFailure(err: unknown): void {
    if (!isGatewayFailure(err)) {
      // Non-gateway errors (validation failures, bad signatures, etc.) don't
      // indicate upstream congestion, so they don't count toward the trip
      // threshold and don't reset the half-open trial.
      return;
    }

    if (this.state === "half-open") {
      // A trial call failed again — go straight back to open and restart
      // the reset timer.
      this.trip();
      return;
    }

    this.consecutiveFailures += 1;
    this.recordEvent("failure");
    if (this.consecutiveFailures >= this.options.failureThreshold) {
      this.trip();
    }
  }

  private trip(): void {
    this.state = "open";
    this.openedAt = this.now();
    this.recordStateGauge();
    this.recordEvent("tripped");
  }

  private close(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.recordStateGauge();
    this.recordEvent("closed");
  }

  /** Forces the circuit back to `closed` with a clean failure count. For ops/tests only. */
  reset(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.halfOpenAttemptsInFlight = 0;
    this.recordStateGauge();
  }

  getStatus(): CircuitBreakerStatus {
    this.maybeTransitionToHalfOpen();
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt || undefined,
      halfOpenAttemptsInFlight: this.halfOpenAttemptsInFlight,
    };
  }

  private recordStateGauge(): void {
    if (!this.metricsRegistry) return;
    // Numeric encoding so the series works as a plain Prometheus gauge:
    // closed=0, half-open=1, open=2.
    const value = this.state === "closed" ? 0 : this.state === "half-open" ? 1 : 2;
    this.metricsRegistry.gauge("soroban_circuit_breaker_state").set(value, { circuit: this.name });
  }

  private recordEvent(event: "failure" | "tripped" | "closed" | "rejected"): void {
    if (!this.metricsRegistry) return;
    this.metricsRegistry
      .counter("soroban_circuit_breaker_events_total")
      .inc(1, { circuit: this.name, event });
  }
}

/** Convenience factory mirroring the other Soroban module constructors in this directory. */
export function createSorobanCircuitBreaker(
  name: string,
  options: Partial<CircuitBreakerOptions> = {},
  dependencies: CircuitBreakerDependencies = {},
): SorobanCircuitBreaker {
  return new SorobanCircuitBreaker(name, options, dependencies);
}
