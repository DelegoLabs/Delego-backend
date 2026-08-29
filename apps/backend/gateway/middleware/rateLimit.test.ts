/**
 * Unit tests for #26 — rate limiting middleware (HTTP layer).
 *
 * Exercises `rateLimitMiddleware` end-to-end against a mocked Redis client:
 * requests under the limit call `next()`, requests over the limit respond
 * 429 with a `Retry-After` header.
 */

import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { rateLimitMiddleware } from "./rateLimit.js";

type MockResponse = ServerResponse & {
  statusCode: number;
  body: string;
  headers: Record<string, string | number>;
};

function createMockReq(options: { url?: string; method?: string; ip?: string } = {}): IncomingMessage {
  return {
    url: options.url ?? "/api/v1/orders",
    method: options.method ?? "GET",
    headers: {},
    socket: { remoteAddress: options.ip ?? "9.9.9.9" },
  } as unknown as IncomingMessage;
}

function createMockRes(): MockResponse {
  const res = {
    statusCode: 0,
    body: "",
    headersSent: false,
    headers: {} as Record<string, string | number>,
    setHeader(name: string, value: string | number) {
      this.headers[name] = value;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      this.headersSent = true;
      if (headers) Object.assign(this.headers, headers);
    },
    end(body?: string) {
      if (body !== undefined) this.body = body;
    },
  };
  return res as MockResponse;
}

function buildMockRedis(initial: Record<string, number> = {}) {
  const store = new Map<string, number>(Object.entries(initial));
  return {
    multi() {
      const ops: Array<() => Promise<[Error | null, unknown]>> = [];
      const pipeline = {
        incr(key: string) {
          ops.push(async () => {
            const next = (store.get(key) ?? 0) + 1;
            store.set(key, next);
            return [null, next];
          });
          return pipeline;
        },
        async exec() {
          const results: Array<[Error | null, unknown]> = [];
          for (const op of ops) results.push(await op());
          return results;
        },
      };
      return pipeline;
    },
    async expire() {
      return 1;
    },
  };
}

describe("rateLimitMiddleware", () => {
  it("calls next() for requests under the limit", async () => {
    const redis = buildMockRedis();
    const middleware = rateLimitMiddleware({ maxRequests: 5, windowMs: 60000, redisClient: redis });
    const req = createMockReq({ ip: "1.1.1.1" });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(res.statusCode).toBe(0);
  });

  it("returns 429 once the limit is exceeded", async () => {
    const redis = buildMockRedis({ "ratelimit:2.2.2.2:GET:/api/v1/orders:0": 5 });
    vi.spyOn(Date, "now").mockReturnValue(0);

    const middleware = rateLimitMiddleware({ maxRequests: 5, windowMs: 60000, redisClient: redis });
    const req = createMockReq({ ip: "2.2.2.2" });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe("RATE_LIMIT_EXCEEDED");

    vi.restoreAllMocks();
  });

  it("includes a Retry-After header on the 429 response", async () => {
    const redis = buildMockRedis({ "ratelimit:3.3.3.3:GET:/api/v1/orders:0": 5 });
    vi.spyOn(Date, "now").mockReturnValue(0);

    const middleware = rateLimitMiddleware({ maxRequests: 5, windowMs: 60000, redisClient: redis });
    const req = createMockReq({ ip: "3.3.3.3" });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.headers["Retry-After"]).toBeDefined();
    expect(Number(res.headers["Retry-After"])).toBeGreaterThan(0);

    vi.restoreAllMocks();
  });

  it("sets RateLimit-* headers on allowed requests", async () => {
    const redis = buildMockRedis();
    const middleware = rateLimitMiddleware({ maxRequests: 5, windowMs: 60000, redisClient: redis });
    const req = createMockReq({ ip: "4.4.4.4" });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.headers["RateLimit-Limit"]).toBe(5);
    expect(res.headers["RateLimit-Remaining"]).toBe(4);
    expect(res.headers["RateLimit-Reset"]).toBeDefined();
  });

  it("bypasses rate limiting for GET /health", async () => {
    const redis = buildMockRedis({ "ratelimit:5.5.5.5:GET:/health:0": 999 });
    const middleware = rateLimitMiddleware({ maxRequests: 5, windowMs: 60000, redisClient: redis });
    const req = createMockReq({ url: "/health", method: "GET", ip: "5.5.5.5" });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
  });

  it("keys the limit per-IP so distinct IPs don't share a bucket", async () => {
    const redis = buildMockRedis({ "ratelimit:6.6.6.6:GET:/api/v1/orders:0": 5 });
    vi.spyOn(Date, "now").mockReturnValue(0);

    const middleware = rateLimitMiddleware({ maxRequests: 5, windowMs: 60000, redisClient: redis });

    const blockedRes = createMockRes();
    await middleware(createMockReq({ ip: "6.6.6.6" }), blockedRes, vi.fn());
    expect(blockedRes.statusCode).toBe(429);

    const allowedRes = createMockRes();
    const allowedNext = vi.fn();
    await middleware(createMockReq({ ip: "7.7.7.7" }), allowedRes, allowedNext);
    expect(allowedNext).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
  });
});
