import test from "node:test";
import assert from "node:assert/strict";
import { PactBrokerManager } from "@delegolabs/utils";

test("Pact Contract Testing & Broker (Issue #88)", async (t) => {
  const broker = new PactBrokerManager();

  const contract = {
    consumer: "delego-gateway",
    provider: "delego-payments",
    interactions: [
      {
        description: "A request for payment creation",
        request: {
          method: "POST",
          path: "/payments/create",
          headers: { "Content-Type": "application/json" },
          body: { amountStroops: "1000000", recipient: "GC123" },
          query: {},
        },
        response: {
          status: 201,
          headers: { "Content-Type": "application/json" },
          body: { id: "pay_123", status: "pending" },
        },
        providerStates: [{ name: "wallet exists", params: {} }],
      },
    ],
    metadata: {
      pactSpecification: "3.0.0",
      timestamp: new Date().toISOString(),
    },
  };

  await t.test("should register contract and verify provider compatibility", () => {
    broker.registerContract(contract);

    const verification = broker.verifyContract(
      "delego-gateway",
      "delego-payments",
      "v1.2.0",
    );

    assert.equal(verification.success, true);
    assert.equal(verification.verifiedInteractions, 1);
    assert.equal(verification.failedInteractions.length, 0);
  });

  await t.test("should validate can-i-deploy gate for verified version", () => {
    const deployCheck = broker.canIDeploy("delego-payments", "v1.2.0", "provider");
    assert.equal(deployCheck.canDeploy, true);
    assert.equal(deployCheck.missingVerifications.length, 0);

    const unverifiedCheck = broker.canIDeploy(
      "delego-payments",
      "v2.0.0-untested",
      "provider",
    );
    assert.equal(unverifiedCheck.canDeploy, false);
    assert.equal(unverifiedCheck.missingVerifications.length, 1);
  });

  await t.test("should auto-generate contract documentation", () => {
    const doc = broker.generateDocumentation("delego-gateway", "delego-payments");
    assert.ok(doc.includes("# Contract: delego-gateway -> delego-payments"));
    assert.ok(doc.includes("POST /payments/create"));
  });
});
