import { describe, expect, beforeEach, it } from "vitest";
import { getRASPConfig, getRASPMetrics, resetRASPMetrics, raspMiddleware, simulateRASPAttack, markRASPFalsePositive } from "./rasp.js";

function request(path: string, body = "") {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    method: "GET", url: path, headers: { host: "localhost" }, socket: { remoteAddress: "10.0.0.1" }, readableEnded: true,
    on(event: string, callback: (...args: unknown[]) => void) { (listeners[event] ??= []).push(callback); return this; },
    once(event: string, callback: (...args: unknown[]) => void) { (listeners[event] ??= []).push(callback); return this; },
    body,
  } as any;
}

function response() {
  return { statusCode: 200, headers: {} as Record<string, unknown>, setHeader(key: string, value: unknown) { this.headers[key] = value; }, writeHead(status: number) { this.statusCode = status; }, end() {} } as any;
}

describe("RASP middleware", () => {
  beforeEach(() => resetRASPMetrics());

  it("blocks common SQL injection payloads", async () => {
    const res = response();
    let continued = false;
    await raspMiddleware(getRASPConfig())(request("/api/v1/status?id=1%20OR%201=1"), res, () => { continued = true; });
    expect(res.statusCode).toBe(403);
    expect(continued).toBe(false);
    expect(getRASPMetrics().blockedRequests).toBe(1);
  });

  it("allows trusted paths to bypass inspection", async () => {
    const res = response();
    let continued = false;
    await raspMiddleware(getRASPConfig())(request("/health?x=<script>alert(1)</script>"), res, () => { continued = true; });
    expect(continued).toBe(true);
    expect(getRASPMetrics().totalEvents).toBe(0);
  });

  it("simulates attacks and records telemetry", () => {
    const event = simulateRASPAttack({ path: "/search?q=%2e%2e%2fetc%2fpasswd" });
    expect(event?.category).toBe("path_traversal");
    expect(event?.action).toBe("blocked");
    expect(getRASPMetrics().totalEvents).toBe(1);
  });

  it("does not flag ordinary input", () => {
    expect(simulateRASPAttack({ path: "/api/v1/status", body: "hello world" })).toBeNull();
    expect(getRASPMetrics().totalEvents).toBe(0);
  });

  it("does not consume the request body stream", async () => {
    const req = request("/api/v1/status");
    let continued = false;
    await raspMiddleware(getRASPConfig())(req, response(), () => { continued = true; });
    expect(continued).toBe(true);
    expect(req.body).toBe("");
  });

  it("redacts sensitive headers in recorded events", async () => {
    const req = request("/api/v1/status?id=1%20OR%201=1");
    req.headers.authorization = "Bearer secret";
    const res = response();
    await raspMiddleware(getRASPConfig())(req, res, () => {});
    const event = (await import("./rasp.js")).getRASPEvents()[0];
    expect(event).toBeDefined();
    expect(event.request.headers.authorization).toBe("[REDACTED]");
    markRASPFalsePositive();
    expect(getRASPMetrics().falsePositiveRate).toBe(0.5);
  });

  it("supports monitor mode without blocking", async () => {
    let continued = false;
    await raspMiddleware({ ...getRASPConfig(), mode: "monitor" })(request("/api/v1/status?id=1%20OR%201=1"), response(), () => { continued = true; });
    expect(continued).toBe(true);
    expect(getRASPMetrics().byAction.blocked).toBeUndefined();
    expect(getRASPMetrics().totalEvents).toBe(1);
  });
});
