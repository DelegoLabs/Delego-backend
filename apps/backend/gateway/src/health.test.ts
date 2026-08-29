import { describe, expect, it } from "vitest";
import { createGatewayHealthRegistry } from "./health.js";

function okFetch(): typeof fetch {
  return (async () => new Response(JSON.stringify({ data: { status: "ok" } }), { status: 200 })) as typeof fetch;
}

function failingFetch(): typeof fetch {
  return (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
}

describe("createGatewayHealthRegistry", () => {
  it("registers postgresql, redis and the downstream services", () => {
    const registry = createGatewayHealthRegistry({});
    expect(registry.names).toEqual(["postgresql", "redis", "orchestrator", "wallet", "payments"]);
  });

  it("reports healthy when all dependencies are healthy", async () => {
    const registry = createGatewayHealthRegistry({
      checkDatabase: async () => 3,
      checkRedis: async () => ({ status: "ok", pingMs: 1 }),
      fetchImpl: okFetch(),
    });
    const health = await registry.getServiceHealth("gateway", "0.0.1");
    expect(health.status).toBe("healthy");
    expect(health.checks[0].details?.latencyMs).toBe(3);
    expect(health.checks[1].details?.pingMs).toBe(1);
  });

  it("fails readiness when the database is down (critical)", async () => {
    const registry = createGatewayHealthRegistry({
      checkDatabase: async () => {
        throw new Error("connection refused");
      },
      checkRedis: async () => ({ status: "ok", pingMs: 1 }),
      fetchImpl: okFetch(),
    });
    const health = await registry.getServiceHealth("gateway", "0.0.1", { readiness: true });
    expect(health.status).toBe("unhealthy");
    expect(health.checks[0].status).toBe("unhealthy");
  });

  it("degrades (but stays ready) when only a downstream service is unreachable", async () => {
    const registry = createGatewayHealthRegistry({
      checkDatabase: async () => 2,
      checkRedis: async () => ({ status: "ok", pingMs: 1 }),
      fetchImpl: failingFetch(),
    });
    const health = await registry.getServiceHealth("gateway", "0.0.1", { readiness: true });
    expect(health.status).toBe("degraded");
    const downstream = health.checks.find((c) => c.name === "wallet");
    expect(downstream?.status).toBe("degraded");
  });

  it("reports degraded for redis failures", async () => {
    const registry = createGatewayHealthRegistry({
      checkDatabase: async () => 2,
      checkRedis: async () => ({ status: "degraded", error: "timeout" }),
      fetchImpl: okFetch(),
    });
    const health = await registry.getServiceHealth("gateway", "0.0.1");
    expect(health.status).toBe("degraded");
    expect(health.checks.find((c) => c.name === "redis")?.details?.error).toBe("timeout");
  });
});
