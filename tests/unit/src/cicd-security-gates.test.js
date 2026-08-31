import test from "node:test";
import assert from "node:assert/strict";
import { CICDPipelineManager } from "@delegolabs/utils";

test("CI/CD Pipeline Stages & Security Gates (Issue #91)", async (t) => {
  const manager = new CICDPipelineManager();

  await t.test("should generate complete CI/CD stages configuration", () => {
    const stages = manager.generatePipelineStages();
    assert.equal(stages.length, 3);
    assert.ok(stages.some((s) => s.name === "build-and-lint"));
    assert.ok(stages.some((s) => s.name === "test-and-security"));
    assert.ok(stages.some((s) => s.name === "deploy-staging"));
  });

  await t.test("should evaluate security gates correctly", () => {
    const cleanScan = { criticalVulnerabilities: 0, secretsExposed: 0 };
    assert.equal(manager.evaluateSecurityGates(cleanScan).passed, true);

    const secretLeak = { criticalVulnerabilities: 0, secretsExposed: 1 };
    const leakResult = manager.evaluateSecurityGates(secretLeak);
    assert.equal(leakResult.passed, false);
    assert.ok(leakResult.reason?.includes("Secrets detected"));

    const vulnScan = { criticalVulnerabilities: 2, secretsExposed: 0 };
    const vulnResult = manager.evaluateSecurityGates(vulnScan);
    assert.equal(vulnResult.passed, false);
    assert.ok(vulnResult.reason?.includes("Critical vulnerabilities found"));
  });

  await t.test("should record deployment and support rollback", () => {
    const successfulDeploy = manager.recordDeployment("staging", "v1.2.3", true);
    assert.equal(successfulDeploy.status, "success");
    assert.equal(successfulDeploy.healthChecks[0].passed, true);

    const failedDeploy = manager.recordDeployment("production", "v1.2.4", false);
    assert.equal(failedDeploy.status, "rolled_back");
    assert.ok(failedDeploy.rollbackVersion);
  });
});
