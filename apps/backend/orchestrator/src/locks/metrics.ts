import { ServiceMetricsRegistry, type AlertRule } from "@delegolabs/utils";
import type { LockLevel } from "./types.js";

export type AcquireResultLabel = "acquired" | "contended" | "timeout" | "stolen";

export class LockMetrics {
  readonly registry: ServiceMetricsRegistry;
  private readonly acquireTotal;
  private readonly acquireDuration;
  private readonly held;
  private readonly renewTotal;
  private readonly stolenTotal;
  private readonly deadlockTotal;
  private readonly contentionRatio;
  private acquires = 0;
  private waits = 0;

  constructor(registry = new ServiceMetricsRegistry()) {
    this.registry = registry;
    this.acquireTotal = registry.counter("orchestrator_lock_acquire_total");
    this.acquireDuration = registry.histogram("orchestrator_lock_acquire_duration_seconds");
    this.held = registry.gauge("orchestrator_lock_held");
    this.renewTotal = registry.counter("orchestrator_lock_renew_total");
    this.stolenTotal = registry.counter("orchestrator_lock_stolen_total");
    this.deadlockTotal = registry.counter("orchestrator_lock_deadlock_timeout_total");
    this.contentionRatio = registry.gauge("orchestrator_lock_contention_ratio");
  }

  recordAcquire(level: LockLevel, result: AcquireResultLabel, durationMs: number, waited: boolean): void {
    this.acquireTotal.inc(1, { level, result });
    this.acquireDuration.observe(durationMs / 1000, { level, result });
    this.acquires += 1;
    if (waited || result === "contended" || result === "timeout") this.waits += 1;
    this.contentionRatio.set(this.acquires === 0 ? 0 : this.waits / this.acquires);
    if (result === "timeout") this.deadlockTotal.inc(1, { level });
    if (result === "stolen") this.stolenTotal.inc(1, { level });
  }

  recordRenew(result: "ok" | "stolen" | "error", level: LockLevel): void {
    this.renewTotal.inc(1, { result });
    if (result === "stolen") this.stolenTotal.inc(1, { level });
  }

  setHeld(level: LockLevel, count: number): void {
    this.held.set(count, { level });
  }

  snapshot(): {
    contentionRatio: number;
    acquires: number;
    waits: number;
  } {
    return {
      contentionRatio: this.acquires === 0 ? 0 : this.waits / this.acquires,
      acquires: this.acquires,
      waits: this.waits,
    };
  }

  toPrometheusText(): string {
    return this.registry.toPrometheusText();
  }
}

export function lockAlertRules(): AlertRule[] {
  return [
    {
      name: "OrchestratorLockContentionHigh",
      expr: "orchestrator_lock_contention_ratio > 0.3",
      for: "5m",
      labels: { severity: "warning", service: "orchestrator" },
      annotations: {
        summary: "Orchestrator lock contention is high",
        description: "More than 30% of lock acquire attempts are waiting or timing out.",
        runbookUrl: "https://github.com/DelegoLabs/Delego-backend/blob/main/apps/backend/orchestrator/README.md",
      },
      severity: "warning",
    },
    {
      name: "OrchestratorLockStolen",
      expr: "rate(orchestrator_lock_stolen_total[5m]) > 0",
      for: "1m",
      labels: { severity: "warning", service: "orchestrator" },
      annotations: {
        summary: "Orchestrator lock steal detected",
        description: "A lock was renewed or held after another instance took ownership — TTL may be too short.",
        runbookUrl: "https://github.com/DelegoLabs/Delego-backend/blob/main/apps/backend/orchestrator/README.md",
      },
      severity: "warning",
    },
    {
      name: "OrchestratorLockDeadlockTimeout",
      expr: "increase(orchestrator_lock_deadlock_timeout_total[5m]) > 0",
      for: "1m",
      labels: { severity: "warning", service: "orchestrator" },
      annotations: {
        summary: "Orchestrator lock wait hit the deadlock timeout",
        description: "A lock acquire waited 30s without succeeding.",
        runbookUrl: "https://github.com/DelegoLabs/Delego-backend/blob/main/apps/backend/orchestrator/README.md",
      },
      severity: "warning",
    },
  ];
}
