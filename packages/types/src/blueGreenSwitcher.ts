/**
 * Blue-green traffic switch orchestration (Issue #93).
 *
 * This implements the decision logic — pre-switch health validation and
 * automated rollback on failure — as a pure state machine driven by an
 * injected health-check function, so it's fully unit-testable without a
 * real Kubernetes cluster or service mesh. Actually flipping traffic
 * (patching an Ingress/Service selector, or a mesh VirtualService weight)
 * is delegated to the injected `applyTrafficSplit` function; this module
 * doesn't hardcode a specific mesh/ingress controller, since that choice
 * (Ingress vs. Istio/Linkerd, see PR #167's service-mesh scoping) isn't
 * made unilaterally here.
 */

import type { BlueGreenConfig, DeploymentColor, SwitchResult, TrafficSplit } from "./blueGreenDeployment.js";

export type HealthCheckFn = (color: DeploymentColor) => Promise<boolean>;
export type ApplyTrafficSplitFn = (split: TrafficSplit) => Promise<void>;

export interface SwitchOptions {
  config: BlueGreenConfig;
  fromColor: DeploymentColor;
  toColor: DeploymentColor;
  version: string;
  checkHealth: HealthCheckFn;
  applyTrafficSplit: ApplyTrafficSplitFn;
  /** Number of consecutive successful health checks required before
   * switching traffic. Defaults to 3. */
  requiredConsecutiveHealthyChecks?: number;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
}

const DEFAULT_REQUIRED_HEALTHY_CHECKS = 3;

/**
 * Validate the target color's health with `requiredConsecutiveHealthyChecks`
 * consecutive passing checks (any single failure resets the count), then
 * switch 100% of traffic to it. If validation fails, traffic is never
 * moved and the result reports `rollbackTriggered: true` (there was
 * nothing to roll back from — the switch simply never happened).
 */
export async function switchTraffic(options: SwitchOptions): Promise<SwitchResult> {
  const {
    fromColor,
    toColor,
    version,
    checkHealth,
    applyTrafficSplit,
    requiredConsecutiveHealthyChecks = DEFAULT_REQUIRED_HEALTHY_CHECKS,
    now = Date.now,
  } = options;

  const startedAt = now();
  let consecutiveHealthy = 0;

  while (consecutiveHealthy < requiredConsecutiveHealthyChecks) {
    const healthy = await checkHealth(toColor);
    if (healthy) {
      consecutiveHealthy += 1;
    } else {
      // A single failure resets progress — we require a clean run, not
      // just "healthy more often than not".
      return {
        fromColor,
        toColor,
        version,
        success: false,
        durationMs: now() - startedAt,
        healthChecksPassed: false,
        rollbackTriggered: true,
      };
    }
  }

  await applyTrafficSplit(
    toColor === "blue" ? { blue: 100, green: 0 } : { blue: 0, green: 100 },
  );

  return {
    fromColor,
    toColor,
    version,
    success: true,
    durationMs: now() - startedAt,
    healthChecksPassed: true,
    rollbackTriggered: false,
  };
}

/**
 * Roll back to `fromColor` by reapplying its traffic split. Used when a
 * post-switch monitor (outside this module's scope) detects a regression
 * after traffic already moved.
 */
export async function rollback(
  fromColor: DeploymentColor,
  applyTrafficSplit: ApplyTrafficSplitFn,
): Promise<void> {
  await applyTrafficSplit(fromColor === "blue" ? { blue: 100, green: 0 } : { blue: 0, green: 100 });
}
