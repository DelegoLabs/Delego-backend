/**
 * Unit tests for Issue #52 — OpenAPI request/response validation middleware.
 */

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { openApiValidationMiddleware } from "./openApiValidation.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeReq(opts: {
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.method = opts.method;
  req.url = opts.url;
  req.headers = opts.headers ?? {};

  // Simulate the body stream asynchronously, same as a real IncomingMessage.
  queueMicrotask(() => {
    if (opts.body !== undefined) {
      const payload = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      req.emit("data", Buffer.from(payload));
    }
    req.emit("end");
  });

  return req;
}

function makeRes() {
  const headers: Record<string, any> = {};
  let statusCode = 200;

  const res = {
    setHeader: (k: string, v: any) => {
      headers[k.toLowerCase()] = v;
    },
    getHeader: (k: string) => headers[k.toLowerCase()],
    removeHeader: (k: string) => {
      delete headers[k.toLowerCase()];
    },
    writeHead: vi.fn((status: number, hdrs?: Record<string, any>) => {
      statusCode = status;
      if (hdrs) {
        Object.assign(headers, Object.fromEntries(Object.entries(hdrs).map(([k, v]) => [k.toLowerCase(), v])));
      }
    }),
    write: vi.fn((_chunk: any) => true),
    end: vi.fn((_chunk?: any) => {}),
  } as unknown as ServerResponse & { end: any; write: any; writeHead: any };

  Object.defineProperty(res, "statusCode", {
    get: () => statusCode,
    set: (v) => {
      statusCode = v;
    },
  });

  return { res, headers };
}

/** Reads the JSON body passed to res.end(...). Must be called after awaiting the middleware. */
function getBody(res: any): any {
  const call = res.end.mock.calls[0];
  return call?.[0] ? JSON.parse(call[0]) : undefined;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("openApiValidationMiddleware", () => {
  it("skips validation and calls next() for unmatched paths", async () => {
    const middleware = openApiValidationMiddleware();
    const req = makeReq({ method: "GET", url: "/not-in-the-spec" });
    const { res } = makeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it("skips configured skip paths (e.g. /health) even if in the spec", async () => {
    const middleware = openApiValidationMiddleware({ skipPaths: ["/health"] });
    const req = makeReq({ method: "GET", url: "/health" });
    const { res } = makeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it("rejects a request body missing required fields with a 400 and structured errors", async () => {
    const middleware = openApiValidationMiddleware();
    const req = makeReq({
      method: "POST",
      url: "/api/v1/delegations",
      body: { agentId: "not-a-uuid" }, // missing walletId, label, policy, permissionLevel
    });
    const { res } = makeRes();
    const next = vi.fn();

    await middleware(req, res, next);
    const body = getBody(res);

    expect(next).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(body.error.details)).toBe(true);
    expect(body.error.details.length).toBeGreaterThan(0);
    expect(body.error.details.some((e: any) => e.code === "required")).toBe(true);
  });

  it("passes through a valid request body and calls next()", async () => {
    const middleware = openApiValidationMiddleware();
    const req = makeReq({
      method: "POST",
      url: "/api/v1/delegations",
      body: {
        agentId: "11111111-1111-1111-1111-111111111111",
        walletId: "22222222-2222-2222-2222-222222222222",
        label: "Groceries",
        policy: {
          maxPerTransaction: "1000",
          maxTotal: "5000",
          allowedMerchants: ["acme"],
          allowedCategories: ["groceries"],
        },
        permissionLevel: "AUTO_APPROVE",
      },
    });
    const { res } = makeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
    expect((req as any).openApiValidated?.body).toBeDefined();
  });

  it("rejects invalid path params (e.g. non-uuid delegation id)", async () => {
    const middleware = openApiValidationMiddleware();
    const req = makeReq({ method: "GET", url: "/api/v1/delegations/not-a-uuid" });
    const { res } = makeRes();
    const next = vi.fn();

    await middleware(req, res, next);
    const body = getBody(res);

    expect(next).not.toHaveBeenCalled();
    expect(body.error.details.some((e: any) => e.field.startsWith("path"))).toBe(true);
  });

  it("rejects malformed JSON bodies with a 400 before reaching handlers", async () => {
    const middleware = openApiValidationMiddleware();
    const req = makeReq({ method: "POST", url: "/api/v1/delegations", body: "{not json" });
    const { res } = makeRes();
    const next = vi.fn();

    await middleware(req, res, next);
    const body = getBody(res);

    expect(next).not.toHaveBeenCalled();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("validates query params against the spec, rejecting out-of-range values", async () => {
    const middleware = openApiValidationMiddleware();
    // /api/v1/delegations GET declares limit: { type: integer, maximum: 100 }
    const req = makeReq({ method: "GET", url: "/api/v1/delegations?limit=99999" });
    const { res } = makeRes();
    const next = vi.fn();

    await middleware(req, res, next);
    const body = getBody(res);

    expect(next).not.toHaveBeenCalled();
    expect(body.error.details.some((e: any) => e.field.startsWith("query"))).toBe(true);
  });

  it("does nothing when disabled", async () => {
    const middleware = openApiValidationMiddleware({ enabled: false });
    const req = makeReq({ method: "POST", url: "/api/v1/delegations", body: {} });
    const { res } = makeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it("supports custom validators referenced from the config map", async () => {
    const customValidators = new Map<string, (value: unknown) => boolean>([
      ["isEven", (value) => typeof value === "number" && value % 2 === 0],
    ]);
    const middleware = openApiValidationMiddleware({ customValidators });

    // No path in the built-in spec currently references a custom keyword —
    // this exercises that the engine wires the keyword into AJV without
    // throwing, and unrelated requests are unaffected.
    const req = makeReq({ method: "GET", url: "/api/v1/status" });
    const { res } = makeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});
