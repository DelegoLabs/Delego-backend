/**
 * Unit tests for #80 — CORS and security-header middleware.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { corsMiddleware, securityHeadersMiddleware } from "./security.js";

function makeReq(origin?: string, method = "GET"): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.headers = origin ? { origin } : {};
  req.url = "/api/v1/delegations";
  req.method = method;
  return req;
}

function makeRes(): ServerResponse & { headers: Record<string, string>; statusCode?: number; ended: boolean } {
  const headers: Record<string, string> = {};
  const res: any = new EventEmitter();
  res.headers = headers;
  res.ended = false;
  res.setHeader = (k: string, v: any) => {
    headers[k.toLowerCase()] = String(v);
  };
  res.getHeader = (k: string) => headers[k.toLowerCase()];
  res.writeHead = (status: number) => {
    res.statusCode = status;
  };
  res.end = () => {
    res.ended = true;
  };
  return res;
}

describe("corsMiddleware", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, CORS_ORIGIN: "https://app.delego.dev,https://admin.delego.dev" };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  it("allows a whitelisted origin", () => {
    const middleware = corsMiddleware();
    const req = makeReq("https://app.delego.dev");
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.headers["access-control-allow-origin"]).toBe("https://app.delego.dev");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-whitelisted origin without setting the allow header", () => {
    const middleware = corsMiddleware();
    const req = makeReq("https://evil.example.com");
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not set the allow header for a server-to-server request with no Origin", () => {
    const middleware = corsMiddleware();
    const req = makeReq(undefined);
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("short-circuits an OPTIONS preflight with 204 and does not call next()", () => {
    const middleware = corsMiddleware();
    const req = makeReq("https://app.delego.dev", "OPTIONS");
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it("sets Access-Control-Max-Age for preflight caching", () => {
    const middleware = corsMiddleware({ maxAgeSeconds: 300 });
    const req = makeReq("https://app.delego.dev", "OPTIONS");
    const res = makeRes();

    middleware(req, res, vi.fn());

    expect(res.headers["access-control-max-age"]).toBe("300");
  });

  it("sets Access-Control-Allow-Credentials only when credentials option is true", () => {
    const middleware = corsMiddleware({ credentials: true });
    const req = makeReq("https://app.delego.dev");
    const res = makeRes();

    middleware(req, res, vi.fn());

    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("defaults to no cross-origin access in production when CORS_ORIGIN is unset", () => {
    process.env = { ...ORIGINAL_ENV, NODE_ENV: "production", CORS_ORIGIN: undefined };
    const middleware = corsMiddleware();
    const req = makeReq("https://app.delego.dev");
    const res = makeRes();

    middleware(req, res, vi.fn());

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("falls back to dev localhost origins in development when CORS_ORIGIN is unset", () => {
    process.env = { ...ORIGINAL_ENV, NODE_ENV: "development", CORS_ORIGIN: undefined };
    const middleware = corsMiddleware();
    const req = makeReq("http://localhost:3001");
    const res = makeRes();

    middleware(req, res, vi.fn());

    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3001");
  });

  it("respects explicit allowedOrigins over env/defaults", () => {
    const middleware = corsMiddleware({ allowedOrigins: ["https://custom.example.com"] });
    const req = makeReq("https://app.delego.dev"); // in CORS_ORIGIN env, but not in explicit list
    const res = makeRes();

    middleware(req, res, vi.fn());

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("securityHeadersMiddleware", () => {
  it("sends CSP as report-only by default", () => {
    const middleware = securityHeadersMiddleware();
    const req = makeReq();
    const res = makeRes();

    middleware(req, res, vi.fn());

    expect(res.headers["content-security-policy-report-only"]).toContain("default-src 'none'");
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });

  it("sends CSP as the enforcing header when cspReportOnly is false", () => {
    const middleware = securityHeadersMiddleware({ cspReportOnly: false });
    const req = makeReq();
    const res = makeRes();

    middleware(req, res, vi.fn());

    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["content-security-policy-report-only"]).toBeUndefined();
  });

  it("includes a report-uri directive when cspReportUri is set", () => {
    const middleware = securityHeadersMiddleware({ cspReportUri: "/csp-reports" });
    const req = makeReq();
    const res = makeRes();

    middleware(req, res, vi.fn());

    expect(res.headers["content-security-policy-report-only"]).toContain("report-uri /csp-reports");
  });

  it("sets X-Frame-Options to DENY by default", () => {
    const middleware = securityHeadersMiddleware();
    const req = makeReq();
    const res = makeRes();

    middleware(req, res, vi.fn());

    expect(res.headers["x-frame-options"]).toBe("DENY");
  });

  it("allows overriding X-Frame-Options to SAMEORIGIN", () => {
    const middleware = securityHeadersMiddleware({ frameOptions: "SAMEORIGIN" });
    const req = makeReq();
    const res = makeRes();

    middleware(req, res, vi.fn());

    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("sets X-Content-Type-Options, Referrer-Policy, and Permissions-Policy", () => {
    const middleware = securityHeadersMiddleware();
    const req = makeReq();
    const res = makeRes();

    middleware(req, res, vi.fn());

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(res.headers["permissions-policy"]).toContain("camera=()");
  });

  it("sets COOP and CORP even without HSTS enabled", () => {
    const middleware = securityHeadersMiddleware();
    const req = makeReq();
    const res = makeRes();

    middleware(req, res, vi.fn());

    expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
  });

  it("does not set HSTS or COEP when hstsEnabled is false (the default)", () => {
    const middleware = securityHeadersMiddleware();
    const req = makeReq();
    const res = makeRes();

    middleware(req, res, vi.fn());

    expect(res.headers["strict-transport-security"]).toBeUndefined();
    expect(res.headers["cross-origin-embedder-policy"]).toBeUndefined();
  });

  it("sets HSTS and COEP when hstsEnabled is true", () => {
    const middleware = securityHeadersMiddleware({ hstsEnabled: true, hstsMaxAgeSeconds: 3600 });
    const req = makeReq();
    const res = makeRes();

    middleware(req, res, vi.fn());

    expect(res.headers["strict-transport-security"]).toBe("max-age=3600; includeSubDomains; preload");
    expect(res.headers["cross-origin-embedder-policy"]).toBe("require-corp");
  });

  it("always calls next()", () => {
    const middleware = securityHeadersMiddleware();
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("accepts custom CSP directives", () => {
    const middleware = securityHeadersMiddleware({
      cspDirectives: { "default-src": ["'self'"], "img-src": ["'self'", "https:"] },
    });
    const req = makeReq();
    const res = makeRes();

    middleware(req, res, vi.fn());

    const csp = res.headers["content-security-policy-report-only"];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("img-src 'self' https:");
  });
});
