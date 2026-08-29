import { describe, expect, it, afterEach, vi } from "vitest";
import { createHealthRoutes, type Route } from "@delegolabs/utils";
import { createGatewayHealthRegistry } from "../src/health.js";

type RouteHandler = (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  params: Record<string, string>,
) => void | Promise<void>;

function findHandler(routes: Route[], path: string): RouteHandler {
  const route = routes.find((r) => r.pattern.test(path));
  if (!route) throw new Error(`No route matches ${path}`);
  return route.handler;
}

function capture(handler: RouteHandler, path: string): () => { status: number; body: string } {
  const res = {
    statusCode: 0,
    body: "",
    headersSent: false,
    headers: {} as Record<string, string>,
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      this.headersSent = true;
      if (headers) Object.assign(this.headers, headers);
    },
    end(body?: string) {
      if (body !== undefined) this.body = body;
    },
  } as unknown as import("node:http").ServerResponse;

  const promise = handler({ url: path } as import("node:http").IncomingMessage, res, {});
  const settled = Promise.resolve(promise).then(() => ({
    status: res.statusCode,
    body: res.body,
  }));
  return () => settled;
}

function makeRoutes(): Route[] {
  return createHealthRoutes({
    registry: createGatewayHealthRegistry({
      checkDatabase: async () => 2,
      checkRedis: async () => ({ status: "ok", pingMs: 1 }),
      fetchImpl: (async () => new Response("ok", { status: 200 })) as typeof fetch,
    }),
    serviceName: "gateway",
  });
}

describe("gateway health routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers live, ready, aggregate, dashboard, metrics and config routes", () => {
    const routes = makeRoutes();
    expect(routes.some((r) => r.pattern.test("/health/live"))).toBe(true);
    expect(routes.some((r) => r.pattern.test("/health/ready"))).toBe(true);
    expect(routes.some((r) => r.pattern.test("/health"))).toBe(true);
    expect(routes.some((r) => r.pattern.test("/health/dashboard"))).toBe(true);
    expect(routes.some((r) => r.pattern.test("/health/metrics"))).toBe(true);
    expect(routes.some((r) => r.pattern.test("/health/config"))).toBe(true);
  });

  it("/health/live returns 200 with ok status", async () => {
    const routes = makeRoutes();
    const result = await capture(findHandler(routes, "/health/live"), "/health/live")();
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.status).toBe("ok");
    expect(body.data.service).toBe("gateway");
  });

  it("/health/ready returns 200 when dependencies are healthy", async () => {
    const routes = makeRoutes();
    const result = await capture(findHandler(routes, "/health/ready"), "/health/ready")();
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.status).toBe("ok");
    expect(body.data.checks.length).toBe(5);
  });

  it("/health returns the aggregate with legacy status values", async () => {
    const routes = makeRoutes();
    const result = await capture(findHandler(routes, "/health"), "/health")();
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.status).toBe("ok");
    expect(body.data.checks[0].name).toBe("postgresql");
    expect(body.error).toBeNull();
  });
});
