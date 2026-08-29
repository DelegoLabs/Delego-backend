import test from "node:test";
import assert from "node:assert/strict";
import {
  TestFixtureFactory,
  ContractTestRunner,
} from "@delegolabs/utils";

test("Integration Test Fixtures & TestContainers (Issue #86)", async (t) => {
  const factory = new TestFixtureFactory();

  await t.test("should create and spin up test context with fixtures", async () => {
    const ctx = await factory.createTestContext({
      postgres: {
        image: "postgres:16-alpine",
        username: "test",
        password: "pw",
        database: "delego_integration",
      },
      redis: {
        image: "redis:7-alpine",
        port: 6379,
      },
      network: "test-net",
    });

    assert.ok(ctx.containers.postgres);
    assert.ok(ctx.containers.redis);
    assert.equal(ctx.containers.postgres.getDatabase(), "delego_integration");

    const user = await ctx.fixtures.createUser({ displayName: "Alice Builder" });
    assert.ok(user.id.startsWith("usr_"));
    assert.equal(user.displayName, "Alice Builder");

    const wallet = await ctx.fixtures.createWallet({ userId: user.id });
    assert.ok(wallet.id.startsWith("wlt_"));
    assert.equal(wallet.userId, user.id);

    const delegation = await ctx.fixtures.createDelegation({
      userId: user.id,
      policy: {
        maxPerTransaction: 5000000n,
        maxTotal: 50000000n,
        allowedMerchants: ["mch_superstore"],
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
    });
    assert.ok(delegation.id.startsWith("dlg_"));
    assert.equal(delegation.policy.maxPerTransaction, 5000000n);

    const order = await ctx.fixtures.createOrder({
      userId: user.id,
      delegationId: delegation.id,
    });
    assert.ok(order.id.startsWith("ord_"));
    assert.equal(order.status, "draft");

    await ctx.fixtures.cleanup();
  });

  await t.test("should validate API contract tests", () => {
    const runner = new ContractTestRunner();

    const contractTest = {
      endpoint: "/api/v1/escrow/release",
      method: "POST",
      requestSchema: { type: "object" },
      responseSchema: { type: "object" },
      testCases: [
        {
          name: "Valid release request from escrow owner",
          input: { escrowId: "esc_123", signature: "sig_abc" },
          expectedStatus: 200,
        },
        {
          name: "Invalid signature returns 401",
          input: { escrowId: "esc_123", signature: "invalid" },
          expectedStatus: 401,
        },
      ],
    };

    const result = runner.validateContract(contractTest);
    assert.equal(result.endpoint, "/api/v1/escrow/release");
    assert.equal(result.passed, true);
    assert.equal(result.results.length, 2);
  });
});
