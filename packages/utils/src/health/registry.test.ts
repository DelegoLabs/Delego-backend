import { describe, expect, it, vi } from "vitest";
import { HealthRegistry, aggregateStatus } from "./index.js";
import type { HealthCheck } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function check(name: string, status: "healthy" | "degraded" | "unhealthy"): HealthCheck {
  return {
    name,
    status,
    latencyMs: 1,
    checkedAt: new Date().toISOString(),
  };
}

describe("aggregateStatus", () => {
  it("returns healthy when all checks are healthy", () => {
    expect(aggregateStatus([check("a", "healthy"), check("b", "healthy")])).toBe("healthy");
  });

  it("returns degraded when any check is degraded", () => {
    expect(aggregateStatus([check("a", "healthy"), check("b", "degraded")])).toBe("degraded");
  });

  it("returns unhealthy when any check is unhealthy", () => {
    expect(aggregateStatus([check("a", "healthy"), check("b", "unhealthy")])).toBe("unhealthy");
  });
});

describe("HealthRegistry", () => {
  it("registers and runs checks, aggregating healthy status", async () => {
    const registry = new HealthRegistry();
    registry.register("db", async () => ({ status: "healthy", details: { ok: true } }), {
      type: "database",
      critical: true,
    });
    registry.register("redis", async () => undefined, { type: "redis", critical: true });

    const health = await registry.getServiceHealth("gateway", "0.0.1");

    expect(health.service).toBe("gateway");
    expect(health.version).toBe("0.0.1");
    expect(health.status).toBe("healthy");
    expect(health.checks).toHaveLength(2);
    expect(health.checks[0]).toMatchObject({ name: "db", status: "healthy" });
    expect(health.checks[0].latencyMs).toBeGreaterThanOrEqual(0);
    expect(health.checks[0].details).toEqual({ ok: true });
    expect(Number.isFinite(health.uptimeSeconds)).toBe(true);
  });

  it("treats a throwing check as unhealthy", async () => {
    const registry = new HealthRegistry();
    registry.register("db", async () => {
      throw new Error("connection refused");
    });

    const health = await registry.getServiceHealth("svc");
    expect(health.status).toBe("unhealthy");
    expect(health.checks[0].status).toBe("unhealthy");
    expect(health.checks[0].details?.error).toBe("connection refused");
  });

  it("respects per-check timeouts", async () => {
    const registry = new HealthRegistry();
    registry.register("slow", async () => {
      await sleep(500);
      return { status: "healthy" as const };
    }, { timeoutSeconds: 0.05 });

    const health = await registry.getServiceHealth("svc");
    expect(health.status).toBe("unhealthy");
    expect(health.checks[0].details?.error).toContain("timed out");
  });

  it("caches results within the interval and re-runs after expiry", async () => {
    let calls = 0;
    const registry = new HealthRegistry();
    registry.register("db", async () => {
      calls += 1;
      return { status: "healthy" as const };
    }, { intervalSeconds: 60 });

    await registry.checkAll();
    await registry.checkAll();
    expect(calls).toBe(1);

    // A clock that advances lets us simulate cache expiry deterministically.
    let now = Date.now();
    const freshRegistry = new HealthRegistry(() => now);
    let calls2 = 0;
    freshRegistry.register("db", async () => {
      calls2 += 1;
      return { status: "healthy" as const };
    }, { intervalSeconds: 1 });

    await freshRegistry.checkAll();
    await freshRegistry.checkAll();
    expect(calls2).toBe(1);

    now += 2_000; // advance past the 1s interval
    await freshRegistry.checkAll();
    expect(calls2).toBe(2);
  });

  it("smooths healthy->unhealthy transitions using the failure threshold", async () => {
    const registry = new HealthRegistry();
    let failing = false;
    registry.register("db", async () => {
      if (failing) throw new Error("db down");
      return { status: "healthy" as const };
    }, { failureThreshold: 3, intervalSeconds: 0 });

    // Initial run is healthy.
    let health = await registry.getServiceHealth("svc");
    expect(health.status).toBe("healthy");

    // Two consecutive failures are still below the threshold of 3.
    failing = true;
    health = await registry.getServiceHealth("svc");
    expect(health.status).toBe("healthy");
    health = await registry.getServiceHealth("svc");
    expect(health.status).toBe("healthy");

    // Third failure crosses the threshold.
    health = await registry.getServiceHealth("svc");
    expect(health.status).toBe("unhealthy");
  });

  it("smooths recovery using the success threshold", async () => {
    const registry = new HealthRegistry();
    let failing = true;
    registry.register("db", async () => {
      if (failing) throw new Error("db down");
      return { status: "healthy" as const };
    }, { failureThreshold: 1, successThreshold: 3, intervalSeconds: 0 });

    let health = await registry.getServiceHealth("svc");
    expect(health.status).toBe("unhealthy");

    // One success is not enough to flip back to healthy.
    failing = false;
    health = await registry.getServiceHealth("svc");
    expect(health.status).toBe("unhealthy");
    health = await registry.getServiceHealth("svc");
    expect(health.status).toBe("unhealthy");

    health = await registry.getServiceHealth("svc");
    expect(health.status).toBe("healthy");
  });

  it("readiness fails only when a critical dependency is unhealthy", async () => {
    const registry = new HealthRegistry();
    registry.register("db", async () => ({ status: "healthy" as const }), { critical: true });
    registry.register("external-api", async () => ({ status: "unhealthy" as const }), {
      critical: false,
    });

    const health = await registry.getServiceHealth("svc", "0.0.1", { readiness: true });
    // Non-critical failure degrades but does not fail readiness.
    expect(health.status).toBe("degraded");

    const registry2 = new HealthRegistry();
    registry2.register("db", async () => {
      throw new Error("db down");
    }, { critical: true });
    const health2 = await registry2.getServiceHealth("svc", "0.0.1", { readiness: true });
    expect(health2.status).toBe("unhealthy");
  });

  it("builds a HealthCheckConfig from registered dependencies", async () => {
    const registry = new HealthRegistry();
    registry.register("db", async () => ({ status: "healthy" as const }), {
      type: "database",
      critical: true,
      intervalSeconds: 5,
    });
    registry.register("redis", async () => ({ status: "healthy" as const }), {
      type: "redis",
      critical: true,
    });

    const config = registry.getConfig();
    expect(config.dependencies).toHaveLength(2);
    expect(config.dependencies[0]).toMatchObject({ name: "db", type: "database", critical: true });
    expect(config.intervalSeconds).toBe(5);
  });

  it("exposes metrics for each check", async () => {
    const registry = new HealthRegistry();
    registry.register("db", async () => ({ status: "healthy" as const }), {
      type: "database",
      critical: true,
    });
    registry.register("api", async () => ({ status: "degraded" as const }), { type: "http" });

    await registry.checkAll();
    const metrics = registry.getMetrics();
    expect(metrics).toHaveLength(2);
    expect(metrics[0]).toMatchObject({ name: "db", type: "database", critical: true, status: "healthy" });
    expect(metrics[1]).toMatchObject({ name: "api", status: "degraded" });
    expect(metrics[0].lastLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("isFresh/peek expose cached results without re-running", async () => {
    const registry = new HealthRegistry();
    const spy = vi.fn(async () => ({ status: "healthy" as const }));
    registry.register("db", spy, { intervalSeconds: 60 });

    await registry.check("db");
    expect(registry.peek("db")?.status).toBe("healthy");
    expect(registry.isFresh("db", Date.now())).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
