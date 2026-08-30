import test from "node:test";
import assert from "node:assert/strict";
import { CoverageGate } from "@delegolabs/utils";

test("Coverage Gates & Quality Enforcement (Issue #85)", async (t) => {
  const gate = new CoverageGate({
    lines: 80,
    branches: 70,
    functions: 80,
    statements: 80,
  });

  await t.test("should pass when coverage exceeds thresholds", () => {
    const report = {
      total: {
        lines: { covered: 850, total: 1000, pct: 85.0 },
        functions: { covered: 82, total: 100, pct: 82.0 },
        branches: { covered: 75, total: 100, pct: 75.0 },
        statements: { covered: 880, total: 1000, pct: 88.0 },
      },
      byFile: {},
    };

    const mutation = gate.calculateMutationScore(80, 15, 5, 0); // (80 / 100) = 80%

    const evalResult = gate.evaluateCoverage(report, mutation);
    assert.equal(evalResult.passed, true);
    assert.equal(evalResult.failures.length, 0);
    assert.equal(evalResult.summary.lines.passed, true);
    assert.equal(evalResult.summary.branches.passed, true);
    assert.equal(evalResult.summary.mutationScore?.passed, true);
  });

  await t.test("should fail when branch coverage is below threshold", () => {
    const report = {
      total: {
        lines: { covered: 850, total: 1000, pct: 85.0 },
        functions: { covered: 82, total: 100, pct: 82.0 },
        branches: { covered: 65, total: 100, pct: 65.0 }, // below 70
        statements: { covered: 880, total: 1000, pct: 88.0 },
      },
      byFile: {},
    };

    const evalResult = gate.evaluateCoverage(report);
    assert.equal(evalResult.passed, false);
    assert.equal(evalResult.failures.length, 1);
    assert.ok(evalResult.failures[0].includes("Branch coverage 65% is below required 70%"));
  });

  await t.test("should fail when mutation testing score is below 60%", () => {
    const report = {
      total: {
        lines: { covered: 900, total: 1000, pct: 90.0 },
        functions: { covered: 90, total: 100, pct: 90.0 },
        branches: { covered: 85, total: 100, pct: 85.0 },
        statements: { covered: 900, total: 1000, pct: 90.0 },
      },
      byFile: {},
    };

    const weakMutation = gate.calculateMutationScore(40, 50, 10, 0); // 40% < 60%
    const evalResult = gate.evaluateCoverage(report, weakMutation);

    assert.equal(evalResult.passed, false);
    assert.ok(evalResult.failures.some((f) => f.includes("Mutation score 40% is below required 60%")));
  });

  await t.test("should generate correct SVG badges", () => {
    const greenBadge = gate.generateBadgeSvg("coverage", 85.5);
    assert.ok(greenBadge.includes("#4c1")); // Green for >= 80%
    assert.ok(greenBadge.includes("85.5%"));

    const yellowBadge = gate.generateBadgeSvg("coverage", 74.0);
    assert.ok(yellowBadge.includes("#dfb317")); // Yellow for 70-79%

    const redBadge = gate.generateBadgeSvg("coverage", 55.0);
    assert.ok(redBadge.includes("#e05d44")); // Red for < 70%
  });
});
