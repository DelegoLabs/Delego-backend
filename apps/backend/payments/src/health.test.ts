import { describe, expect, it } from "vitest";
import { createPaymentsHealthRegistry } from "./health.js";

describe("createPaymentsHealthRegistry", () => {
  it("registers database, walletService and sorobanRpc", () => {
    const registry = createPaymentsHealthRegistry({});
    expect(registry.names).toEqual(["database", "walletService", "sorobanRpc"]);
  });

  it("reports healthy when all dependencies are healthy", async () => {
    const registry = createPaymentsHealthRegistry({
      checkDatabase: async () => "ok",
      checkWallet: async () => "ok",
      checkSorobanRpc: async () => "ok",
    });
    const health = await registry.getServiceHealth("payments", "0.0.1");
    expect(health.status).toBe("healthy");
    expect(health.checks.map((c) => c.name)).toEqual(["database", "walletService", "sorobanRpc"]);
  });

  it("fails readiness when the database is down (critical)", async () => {
    const registry = createPaymentsHealthRegistry({
      checkDatabase: async () => "degraded",
      checkWallet: async () => "ok",
      checkSorobanRpc: async () => "ok",
    });
    const health = await registry.getServiceHealth("payments", "0.0.1", { readiness: true });
    expect(health.status).toBe("degraded");
  });

  it("degrades but stays ready when only a non-critical dependency is down", async () => {
    const registry = createPaymentsHealthRegistry({
      checkDatabase: async () => "ok",
      checkWallet: async () => "degraded",
      checkSorobanRpc: async () => "degraded",
    });
    const health = await registry.getServiceHealth("payments", "0.0.1", { readiness: true });
    expect(health.status).toBe("degraded");
  });
});
