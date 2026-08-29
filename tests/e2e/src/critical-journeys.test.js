import test from "node:test";
import assert from "node:assert/strict";
import {
  E2EJourneyRunner,
  CRITICAL_USER_JOURNEYS,
} from "@delegolabs/utils";

test("E2E Critical User Journeys (Issue #87)", async (t) => {
  const runner = new E2EJourneyRunner({
    retries: 2,
    trace: true,
  });

  await t.test("should have 10+ critical user journeys defined", () => {
    assert.ok(
      CRITICAL_USER_JOURNEYS.length >= 10,
      `Expected at least 10 journeys, got ${CRITICAL_USER_JOURNEYS.length}`,
    );
  });

  await t.test("should execute individual journey with step retry and tracing", async () => {
    const journey = CRITICAL_USER_JOURNEYS[0];
    const result = await runner.executeJourney(journey);

    assert.equal(result.status, "passed");
    assert.equal(result.journey, journey.name);
    assert.equal(result.steps.length, journey.steps.length);
    assert.ok(result.traceUrl);
    for (const step of result.steps) {
      assert.equal(step.status, "passed");
      assert.ok(step.screenshot);
    }
  });

  await t.test("should successfully execute entire suite of 10+ journeys", async () => {
    const summary = await runner.executeSuite(CRITICAL_USER_JOURNEYS);

    assert.equal(summary.totalJourneys, CRITICAL_USER_JOURNEYS.length);
    assert.equal(summary.passed, CRITICAL_USER_JOURNEYS.length);
    assert.equal(summary.failed, 0);
    assert.ok(summary.durationMs < 900000); // Under 15 mins SLA
  });
});
