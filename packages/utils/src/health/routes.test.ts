import { describe, expect, it, afterEach } from "vitest";
import type { Server } from "node:http";
import { startHttpServer, type Route } from "../http.js";
import { createHealthRoutes, HealthRegistry } from "./index.js";

const servers: Server[] = [];

afterEach(() => {
  for (const server of servers) {
    server.close();
  }
  servers.length = 0;
});

function listen(routes: Route[]): Promise<{ baseUrl: string; server: Server }> {
  return new Promise((resolve) => {
    const server = startHttpServer({
      port: 0,
      host: "127.0.0.1",
      serviceName: "test-svc",
      routes,
    });
    servers.push(server);
    server.once("listening", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, server });
    });
  });
}

interface TestResponse {
  data: {
    status: string;
    service: string;
    version: string;
    timestamp?: string;
    uptimeSeconds?: number;
    checks?: Array<{ name: string; status: string; latencyMs: number; checkedAt: string }>;
    dependencies?: Array<{ name: string; type: string; critical: boolean }>;
  } | null;
  error: { code: string; message: string } | null;
}

async function getJson(url: string): Promise<TestResponse> {
  return (await (await fetch(url)).json()) as TestResponse;
}

function makeRegistry(): HealthRegistry {
  const registry = new HealthRegistry();
  registry.register("db", async () => ({ status: "healthy", details: { engine: "postgres" } }), {
    type: "database",
    critical: true,
  });
  registry.register("redis", async () => ({ status: "healthy" }), { type: "redis", critical: true });
  registry.register("payments", async () => ({ status: "healthy" }), { type: "http" });
  return registry;
}

describe("createHealthRoutes", () => {
  it("serves /health/live with 200 while the process is running", async () => {
    const { baseUrl } = await listen(createHealthRoutes({ registry: makeRegistry(), serviceName: "test-svc" }));
    const res = await fetch(`${baseUrl}/health/live`);
    expect(res.status).toBe(200);
    const body = await getJson(`${baseUrl}/health/live`);
    expect(body.data).toMatchObject({ status: "ok", service: "test-svc", version: "0.0.1" });
    expect(body.error).toBeNull();
    expect(typeof body.data?.uptimeSeconds).toBe("number");
  });

  it("serves /health with the full aggregate and legacy status values", async () => {
    const { baseUrl } = await listen(createHealthRoutes({ registry: makeRegistry(), serviceName: "test-svc" }));
    const body = await getJson(`${baseUrl}/health`);
    expect(body.data?.status).toBe("ok");
    expect(body.data?.checks).toHaveLength(3);
    expect(body.data?.checks?.[0].name).toBe("db");
    expect(body.data?.version).toBe("0.0.1");
    expect(body.error).toBeNull();
  });

  it("returns 200 with degraded status when only a non-critical dependency fails", async () => {
    const registry = makeRegistry();
    registry.register("external-api", async () => {
      throw new Error("unreachable");
    });
    const { baseUrl } = await listen(createHealthRoutes({ registry, serviceName: "test-svc" }));

    const res = await fetch(`${baseUrl}/health/ready`);
    expect(res.status).toBe(200);
    const body = await getJson(`${baseUrl}/health/ready`);
    expect(body.data?.status).toBe("degraded");
  });

  it("returns 503 from /health/ready when a critical dependency is unhealthy", async () => {
    const registry = makeRegistry();
    registry.register("db", async () => {
      throw new Error("db down");
    }, { critical: true });
    const { baseUrl } = await listen(createHealthRoutes({ registry, serviceName: "test-svc" }));

    const res = await fetch(`${baseUrl}/health/ready`);
    expect(res.status).toBe(503);
    const body = await getJson(`${baseUrl}/health/ready`);
    expect(body.data?.status).toBe("down");
  });

  it("serves /health/config with the dependency graph", async () => {
    const { baseUrl } = await listen(createHealthRoutes({ registry: makeRegistry(), serviceName: "test-svc" }));
    const body = await getJson(`${baseUrl}/health/config`);
    expect(body.data?.dependencies).toHaveLength(3);
    expect(body.data?.dependencies?.[0]).toMatchObject({ name: "db", critical: true });
  });

  it("serves /health/metrics in Prometheus text format", async () => {
    const { baseUrl } = await listen(createHealthRoutes({ registry: makeRegistry(), serviceName: "test-svc" }));
    const res = await fetch(`${baseUrl}/health/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(text).toContain("test_svc_uptime_seconds");
    expect(text).toContain('check="db"');
    expect(text).toContain("test_svc_health_check_status");
  });

  it("serves /health/dashboard as HTML", async () => {
    const { baseUrl } = await listen(createHealthRoutes({ registry: makeRegistry(), serviceName: "test-svc" }));
    const res = await fetch(`${baseUrl}/health/dashboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Health Dashboard");
  });
});
