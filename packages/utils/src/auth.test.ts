import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import { requireAuth } from "./auth.js";

function makeReq(): IncomingMessage & EventEmitter {
  const req = new EventEmitter() as IncomingMessage & EventEmitter;
  req.headers = {};
  return req;
}

function signTestToken(payload: Record<string, unknown>, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payloadBuf = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${payloadBuf}`;
  const signature = createHmac("SHA256", secret).update(signingInput).digest("base64url");
  return `${header}.${payloadBuf}.${signature}`;
}

function createMockRes(): ServerResponse & { _chunks: Buffer[]; _headers: Record<string, string>; statusCode: number } {
  const res = {
    _chunks: [] as Buffer[],
    _headers: {} as Record<string, string>,
    statusCode: 0,
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      if (headers) Object.assign(this._headers, headers);
    },
    setHeader(name: string, value: string) {
      this._headers[name] = value;
    },
    end(chunk?: any) {
      if (Buffer.isBuffer(chunk)) this._chunks.push(chunk);
      else if (typeof chunk === "string") this._chunks.push(Buffer.from(chunk));
    },
  } as unknown as ServerResponse & { _chunks: Buffer[]; _headers: Record<string, string>; statusCode: number };
  return res;
}

function collectResponse(res: ServerResponse & { _chunks: Buffer[]; _headers: Record<string, string>; statusCode: number }): { status: number; headers: Record<string, string>; body: string } {
  return {
    status: res.statusCode,
    headers: { ...res._headers },
    body: Buffer.concat(res._chunks).toString("utf8"),
  };
}

describe("requireAuth", () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret-key-minimum-32-chars-long";
  });

  afterEach(() => {
    process.env.JWT_SECRET = originalSecret;
  });

  it("returns 401 when no Authorization header is present", async () => {
    const middleware = requireAuth();
    const req = makeReq();
    req.url = "/checkout";
    const res = createMockRes();

    await middleware(req, res, () => {});

    const result = collectResponse(res);
    expect(result.status).toBe(401);
    expect(result.headers["WWW-Authenticate"]).toBe('Bearer realm="api"');
    const body = JSON.parse(result.body);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when token is malformed", async () => {
    const middleware = requireAuth();
    const req = makeReq();
    req.headers.authorization = "Bearer not-a-valid-jwt";
    req.url = "/checkout";
    const res = createMockRes();

    await middleware(req, res, () => {});

    const result = collectResponse(res);
    expect(result.status).toBe(401);
    expect(result.headers["WWW-Authenticate"]).toBe('Bearer realm="api"');
  });

  it("returns 401 when token is expired", async () => {
    const middleware = requireAuth();
    const expiredToken = signTestToken({ userId: "user-1", exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET!);
    const req = makeReq();
    req.headers.authorization = `Bearer ${expiredToken}`;
    req.url = "/checkout";
    const res = createMockRes();

    await middleware(req, res, () => {});

    const result = collectResponse(res);
    expect(result.status).toBe(401);
    expect(result.headers["WWW-Authenticate"]).toBe('Bearer realm="api"');
  });

  it("calls next() when a valid token is provided", async () => {
    const middleware = requireAuth();
    const validToken = signTestToken({ userId: "user-123" }, process.env.JWT_SECRET!);
    const req = makeReq();
    req.headers.authorization = `Bearer ${validToken}`;
    req.url = "/checkout";
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect((req as any).userId).toBe("user-123");
  });

  it("calls next() without token for public paths", async () => {
    const middleware = requireAuth({ publicPaths: ["/health", "/vapid-public-key"] });
    const req = makeReq();
    req.url = "/health";
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect((req as any).userId).toBeUndefined();
  });

  it("still requires auth for non-public paths", async () => {
    const middleware = requireAuth({ publicPaths: ["/health", "/vapid-public-key"] });
    const req = makeReq();
    req.url = "/checkout";
    const res = createMockRes();

    await middleware(req, res, () => {});

    const result = collectResponse(res);
    expect(result.status).toBe(401);
  });
});
