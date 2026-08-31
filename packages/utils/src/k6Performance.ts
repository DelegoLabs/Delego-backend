/**
 * Performance Testing & k6 Budget Verifier
 * Issue #89
 */

import type {
  PerformanceTest,
  PerformanceBudget,
  PerformanceResult,
  PerformanceMetrics,
} from "@delegolabs/types";

export class K6PerformanceManager {
  /**
   * Create standard k6 performance test definition
   */
  public createPerformanceTest(
    name: string,
    type: "load" | "stress" | "soak" | "spike",
  ): PerformanceTest {
    const stageMap = {
      load: [
        { duration: "2m", target: 50 },
        { duration: "5m", target: 50 },
        { duration: "2m", target: 0 },
      ],
      stress: [
        { duration: "2m", target: 100 },
        { duration: "5m", target: 200 },
        { duration: "2m", target: 0 },
      ],
      soak: [
        { duration: "10m", target: 30 },
        { duration: "8h", target: 30 },
        { duration: "10m", target: 0 },
      ],
      spike: [
        { duration: "1m", target: 10 },
        { duration: "1m", target: 300 },
        { duration: "3m", target: 300 },
        { duration: "1m", target: 0 },
      ],
    };

    return {
      name,
      type,
      stages: stageMap[type],
      thresholds: {
        http_req_duration: ["p(95)<500", "p(99)<1000"],
        http_req_failed: ["rate<0.01"],
        checks: ["rate>0.99"],
      },
      scenarios: {
        default: {
          executor: "ramping-vus",
          exec: "default",
          startVUs: 0,
        },
      },
    };
  }

  /**
   * Evaluate execution metrics against a performance budget
   */
  public evaluateBudget(
    budget: PerformanceBudget,
    metrics: PerformanceMetrics,
    baselineMetrics?: PerformanceMetrics,
  ): PerformanceResult {
    const thresholds = [
      {
        name: "p95_latency",
        passed: metrics.httpReqDuration.p95 <= budget.p95LatencyMs,
        value: metrics.httpReqDuration.p95,
      },
      {
        name: "p99_latency",
        passed: metrics.httpReqDuration.p99 <= budget.p99LatencyMs,
        value: metrics.httpReqDuration.p99,
      },
      {
        name: "error_rate",
        passed: metrics.httpReqFailed.rate <= budget.errorRate,
        value: metrics.httpReqFailed.rate,
      },
    ];

    let regressionDetected = false;
    if (baselineMetrics) {
      const variance =
        (metrics.httpReqDuration.p95 - baselineMetrics.httpReqDuration.p95) /
        baselineMetrics.httpReqDuration.p95;
      if (variance > 0.05) {
        // > 5% regression variance
        regressionDetected = true;
      }
    }

    const passed = thresholds.every((t) => t.passed) && !regressionDetected;

    return {
      testName: budget.endpoint,
      passed,
      metrics,
      thresholds,
      regressionDetected,
    };
  }
}
