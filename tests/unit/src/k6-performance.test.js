import test from "node:test";
import assert from "node:assert/strict";
import { K6PerformanceManager } from "@delegolabs/utils";

test("k6 Performance Testing & Latency Budgets (Issue #89)", async (t) => {
  const manager = new K6PerformanceManager();

  await t.test("should generate standard k6 test configurations", () => {
    const loadTest = manager.createPerformanceTest("Gateway API", "load");
    assert.equal(loadTest.type, "load");
    assert.ok(loadTest.stages.length >= 3);
    assert.ok(loadTest.thresholds.http_req_duration.includes("p(95)<500"));

    const soakTest = manager.createPerformanceTest("Payments Service", "soak");
    assert.equal(soakTest.type, "soak");
    assert.ok(soakTest.stages.some((s) => s.duration === "8h"));
  });

  await t.test("should evaluate performance metrics against budget", () => {
    const budget = {
      endpoint: "/api/v1/payments",
      p50LatencyMs: 100,
      p95LatencyMs: 250,
      p99LatencyMs: 500,
      throughputRps: 1000,
      errorRate: 0.01,
      availability: 0.999,
    };

    const goodMetrics = {
      httpReqDuration: { avg: 80, p50: 75, p95: 180, p99: 320, max: 450 },
      httpReqFailed: { rate: 0.002, count: 2 },
      vus: 100,
      iterations: 5000,
    };

    const result = manager.evaluateBudget(budget, goodMetrics);
    assert.equal(result.passed, true);
    assert.equal(result.regressionDetected, false);
  });

  await t.test("should detect performance regressions exceeding 5% variance", () => {
    const budget = {
      endpoint: "/api/v1/checkout",
      p50LatencyMs: 100,
      p95LatencyMs: 400,
      p99LatencyMs: 800,
      throughputRps: 500,
      errorRate: 0.01,
      availability: 0.999,
    };

    const baselineMetrics = {
      httpReqDuration: { avg: 100, p50: 90, p95: 200, p99: 350, max: 500 },
      httpReqFailed: { rate: 0, count: 0 },
      vus: 50,
      iterations: 2000,
    };

    const regressedMetrics = {
      httpReqDuration: { avg: 140, p50: 130, p95: 280, p99: 450, max: 600 }, // +40% latency
      httpReqFailed: { rate: 0, count: 0 },
      vus: 50,
      iterations: 2000,
    };

    const result = manager.evaluateBudget(budget, regressedMetrics, baselineMetrics);
    assert.equal(result.regressionDetected, true);
    assert.equal(result.passed, false);
  });
});
