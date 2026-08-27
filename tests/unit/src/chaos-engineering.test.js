import test from "node:test";
import assert from "node:assert/strict";
import { ChaosEngine } from "@delegolabs/utils";

test("Chaos Engineering & Resilience Experiments (Issue #90)", async (t) => {
  const engine = new ChaosEngine();

  const experiment = {
    name: "Redis Cache Failure Resilience",
    description: "Simulate Redis failure and ensure database fallback sustains traffic",
    hypothesis: "Gateway latency increases but error rate stays below 1%",
    steadyState: {
      metrics: ["error_rate", "p95_latency"],
      thresholds: {
        error_rate: 0.01,
        p95_latency: 500,
      },
    },
    method: [
      {
        type: "network_loss",
        target: "app=redis",
        config: { percentage: 100 },
        duration: "5m",
      },
    ],
    rollback: {
      automatic: true,
      conditions: ["error_rate > 0.05"],
    },
  };

  await t.test("should enforce blast radius and safety rules", () => {
    assert.throws(
      () => engine.validateExperiment(experiment, "production"),
      /Chaos experiments cannot run in production directly/,
    );

    assert.equal(engine.validateExperiment(experiment, "staging"), true);
  });

  await t.test("should evaluate successful experiment when steady state is preserved", () => {
    const observedMetrics = {
      error_rate: 0.004,
      p95_latency: 320,
    };

    const result = engine.runExperiment(experiment, observedMetrics);
    assert.equal(result.steadyStateMaintained, true);
    assert.equal(result.incidents.length, 0);
    assert.ok(result.conclusion.includes("Hypothesis verified"));
  });

  await t.test("should trigger automatic rollback when SLO threshold is breached", () => {
    const breachMetrics = {
      error_rate: 0.08, // > 0.01 threshold
      p95_latency: 650, // > 500 threshold
    };

    const result = engine.runExperiment(experiment, breachMetrics);
    assert.equal(result.steadyStateMaintained, false);
    assert.equal(result.incidents.length, 2);
    assert.equal(result.incidents[0].resolved, true); // auto rollback resolved
  });
});
