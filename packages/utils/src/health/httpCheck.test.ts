import { describe, expect, it } from "vitest";
import { httpHealthCheck } from "./httpCheck.js";

describe("httpHealthCheck", () => {
  it("reports healthy for a 2xx endpoint", async () => {
    const check = httpHealthCheck({
      url: "http://svc.test/health",
      fetchImpl: async () => new Response("ok", { status: 200 }),
    });
    const result = await check();
    expect(result?.status).toBe("healthy");
  });

  it("reports degraded when the endpoint responds with an error status", async () => {
    const check = httpHealthCheck({
      url: "http://svc.test/health",
      fetchImpl: async () => new Response("down", { status: 503 }),
    });
    const result = await check();
    expect(result?.status).toBe("degraded");
    expect(result?.details?.httpStatus).toBe(503);
  });

  it("throws (unhealthy) when the endpoint is unreachable", async () => {
    const check = httpHealthCheck({
      url: "http://svc.test/health",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(check()).rejects.toThrow("ECONNREFUSED");
  });

  it("evaluates bodyStatus when provided", async () => {
    const check = httpHealthCheck({
      url: "http://svc.test/health",
      fetchImpl: async () => new Response(JSON.stringify({ status: "degraded" }), { status: 200 }),
      bodyStatus: (body) => (body as { status?: string }).status === "ok" ? "healthy" : "degraded",
    });
    const result = await check();
    expect(result?.status).toBe("degraded");
  });
});
