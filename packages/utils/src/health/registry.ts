/**
 * HealthRegistry — runs registered dependency checks with:
 *  - per-check caching (results are served while fresh)
 *  - failure/success threshold smoothing
 *  - latency tracking and metrics counters
 *  - graceful degradation (healthy / degraded / unhealthy aggregation)
 *
 * See packages/utils/src/health for the full health-check framework (Issue #76).
 */

import { createLogger } from "../logger.js";
import type {
  CheckResult,
  DependencyConfig,
  DependencyType,
  HealthCheck,
  HealthCheckConfig,
  HealthCheckFn,
  HealthMetrics,
  HealthStatus,
  ServiceHealth,
} from "./types.js";

export interface RegisterOptions {
  type?: DependencyType;
  critical?: boolean;
  intervalSeconds?: number;
  timeoutSeconds?: number;
  failureThreshold?: number;
  successThreshold?: number;
}

interface CheckRegistration {
  name: string;
  type: DependencyType;
  critical: boolean;
  check: HealthCheckFn;
  config: {
    intervalSeconds: number;
    timeoutSeconds: number;
    failureThreshold: number;
    successThreshold: number;
  };
}

interface CachedResult {
  check: HealthCheck;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}

const DEFAULT_INTERVAL_SECONDS = 10;
const DEFAULT_TIMEOUT_SECONDS = 2;
const DEFAULT_FAILURE_THRESHOLD = 2;
const DEFAULT_SUCCESS_THRESHOLD = 1;

const log = createLogger("utils:health", process.env.LOG_LEVEL ?? "info");

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Smoothes a raw check result using failure/success thresholds so a single
 * transient failure does not flap a dependency between healthy and unhealthy.
 */
function applyThresholds(
  prev: CachedResult | undefined,
  raw: HealthStatus,
  config: { failureThreshold: number; successThreshold: number },
): { status: HealthStatus; consecutiveFailures: number; consecutiveSuccesses: number } {
  const prevStatus = prev?.check.status;
  let failures = prev?.consecutiveFailures ?? 0;
  let successes = prev?.consecutiveSuccesses ?? 0;

  if (raw === "healthy") {
    failures = 0;
    successes = prevStatus === "healthy" ? successes : successes + 1;
    if (prevStatus === "healthy" || successes >= config.successThreshold) {
      return {
        status: "healthy",
        consecutiveFailures: failures,
        consecutiveSuccesses: Math.min(successes, config.successThreshold),
      };
    }
    // Recovering — keep the previous (non-healthy) status until the success
    // threshold is reached so one good probe doesn't hide a flapping dependency.
    return {
      status: prevStatus ?? "healthy",
      consecutiveFailures: failures,
      consecutiveSuccesses: successes,
    };
  }

  successes = 0;
  failures += 1;

  if (prevStatus === "healthy" && failures < config.failureThreshold) {
    // A single blip should not flip a healthy dependency to degraded/unhealthy.
    return {
      status: "healthy",
      consecutiveFailures: failures,
      consecutiveSuccesses: successes,
    };
  }

  // Already non-healthy (or threshold reached): the worse status wins.
  let status: HealthStatus = raw;
  if (prevStatus && prevStatus !== "healthy") {
    status = prevStatus === "unhealthy" || raw === "unhealthy" ? "unhealthy" : "degraded";
  }

  return { status, consecutiveFailures: failures, consecutiveSuccesses: successes };
}

export function aggregateStatus(checks: HealthCheck[]): HealthStatus {
  if (checks.some((c) => c.status === "unhealthy")) return "unhealthy";
  if (checks.some((c) => c.status === "degraded")) return "degraded";
  return "healthy";
}

export class HealthRegistry {
  private readonly registrations = new Map<string, CheckRegistration>();
  private readonly results = new Map<string, CachedResult>();
  private readonly startedAtMs: number;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.startedAtMs = now();
  }

  get names(): string[] {
    return [...this.registrations.keys()];
  }

  get size(): number {
    return this.registrations.size;
  }

  register(name: string, check: HealthCheckFn, options: RegisterOptions = {}): void {
    this.registrations.set(name, {
      name,
      type: options.type ?? "custom",
      critical: options.critical ?? false,
      check,
      config: {
        intervalSeconds: options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
        timeoutSeconds: options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
        failureThreshold: options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
        successThreshold: options.successThreshold ?? DEFAULT_SUCCESS_THRESHOLD,
      },
    });
  }

  isFresh(name: string, at: number): boolean {
    const cached = this.results.get(name);
    if (!cached) return false;
    const reg = this.registrations.get(name);
    if (!reg) return false;
    return at - Date.parse(cached.check.checkedAt) < reg.config.intervalSeconds * 1000;
  }

  /** Returns the last recorded result for a check without re-running it. */
  peek(name: string): HealthCheck | undefined {
    return this.results.get(name)?.check;
  }

  /** Runs a single check, serving the cached result while it is still fresh. */
  async check(name: string): Promise<HealthCheck> {
    const reg = this.registrations.get(name);
    if (!reg) throw new Error(`Unknown health check: ${name}`);

    const at = this.now();
    const cached = this.results.get(name);
    if (cached && this.isFresh(name, at)) {
      return cached.check;
    }

    return this.runCheck(reg, at);
  }

  private async runCheck(reg: CheckRegistration, at: number): Promise<HealthCheck> {
    const startedAt = performance.now();
    const timeoutMs = reg.config.timeoutSeconds * 1000;

    let raw: HealthStatus = "healthy";
    let details: Record<string, unknown> | undefined;

    try {
      const result = await withTimeout<CheckResult | void>(reg.check(), timeoutMs, `${reg.name} health check`);
      raw = result?.status ?? "healthy";
      details = result?.details;
    } catch (err) {
      raw = "unhealthy";
      details = { error: errorMessage(err) };
    }

    const latencyMs = Math.round(performance.now() - startedAt);
    const prev = this.results.get(reg.name);
    const { status, consecutiveFailures, consecutiveSuccesses } = applyThresholds(
      prev,
      raw,
      reg.config,
    );

    const check: HealthCheck = {
      name: reg.name,
      status,
      latencyMs,
      details: details ? { ...details } : undefined,
      checkedAt: new Date(at).toISOString(),
    };

    this.results.set(reg.name, { check, consecutiveFailures, consecutiveSuccesses });

    if (status !== "healthy") {
      log.warn("Health check is not healthy", {
        check: reg.name,
        status,
        latencyMs,
        details,
      });
    }

    return check;
  }

  /** Runs all registered checks in parallel, respecting per-check caches. */
  async checkAll(): Promise<HealthCheck[]> {
    const results = await Promise.all(this.names.map((name) => this.check(name)));
    const byName = new Map(results.map((r) => [r.name, r]));
    return this.names.map((name) => byName.get(name)!);
  }

  getUptimeSeconds(): number {
    return Math.floor((this.now() - this.startedAtMs) / 1000);
  }

  get startedAt(): number {
    return this.startedAtMs;
  }

  /** Returns the effective HealthCheckConfig derived from registered checks. */
  getConfig(): HealthCheckConfig {
    const registrations = [...this.registrations.values()];
    return {
      intervalSeconds: registrations[0]?.config.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
      timeoutSeconds: Math.max(...registrations.map((r) => r.config.timeoutSeconds), 0),
      failureThreshold: Math.max(...registrations.map((r) => r.config.failureThreshold), 0),
      successThreshold: Math.max(...registrations.map((r) => r.config.successThreshold), 0),
      dependencies: registrations.map(
        (r): DependencyConfig => ({
          name: r.name,
          type: r.type,
          critical: r.critical,
          config: { intervalSeconds: r.config.intervalSeconds, timeoutSeconds: r.config.timeoutSeconds },
        }),
      ),
    };
  }

  /** Aggregated status across the given checks. */
  getStatus(checks: HealthCheck[]): HealthStatus {
    return aggregateStatus(checks);
  }

  /**
   * Readiness status — fails (unhealthy) only when a *critical* dependency is
   * down. Non-critical failures degrade readiness without failing the probe so
   * traffic keeps flowing (graceful degradation).
   */
  getReadinessStatus(checks: HealthCheck[]): HealthStatus {
    const critical = checks.filter((c) => this.registrations.get(c.name)?.critical ?? false);
    const criticalUnhealthy = critical.some((c) => c.status === "unhealthy");
    if (criticalUnhealthy) return "unhealthy";
    return checks.some((c) => c.status !== "healthy") ? "degraded" : "healthy";
  }

  /** Builds the ServiceHealth payload for a service. */
  async getServiceHealth(
    service: string,
    version = "0.0.1",
    opts: { readiness?: boolean } = {},
  ): Promise<ServiceHealth> {
    const checks = await this.checkAll();
    const status = opts.readiness ? this.getReadinessStatus(checks) : aggregateStatus(checks);
    return {
      service,
      status,
      checks,
      version,
      uptimeSeconds: this.getUptimeSeconds(),
    };
  }

  getMetrics(): HealthMetrics[] {
    return this.names.map((name) => {
      const cached = this.results.get(name);
      const reg = this.registrations.get(name)!;
      const check = cached?.check;
      return {
        name,
        type: reg.type,
        critical: reg.critical,
        status: check?.status ?? "unhealthy",
        total: check ? 1 : 0,
        healthy: check?.status === "healthy" ? 1 : 0,
        degraded: check?.status === "degraded" ? 1 : 0,
        unhealthy: check?.status === "unhealthy" ? 1 : 0,
        lastLatencyMs: check?.latencyMs ?? 0,
        consecutiveFailures: cached?.consecutiveFailures ?? 0,
        consecutiveSuccesses: cached?.consecutiveSuccesses ?? 0,
      };
    });
  }
}
