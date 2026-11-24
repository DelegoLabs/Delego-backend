import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  registerSigningKey,
  revokeSigningKey,
  getSigningKey,
  signRequest,
  verifySignature,
  requestSigningMiddleware,
  cleanupExpiredNonces,
  resetSigningState,
} from "./requestSigning.js";

const TEST_KEY_ID = "key-test-1";
const TEST_SECRET = Buffer.from("super-secret-signing-key-32bytes!").toString("base64");

type MockResponse = ServerResponse & {
  statusCode: number;
  body: string;
};

function createMockReq(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const body = options.body ?? "";
  const stream = Readable.from(body ? [Buffer.from(body, "utf-8")] : []);
  return Object.assign(stream, {
    method: options.method ?? "POST",
    url: options.url ?? "/api/v1/payments",
    headers: { host: "localhost", ...(options.headers ?? {}) },
  }) as unknown as IncomingMessage;
}

function createMockRes(): MockResponse {
  const res = {
    statusCode: 0,
    body: "",
    setHeader() {},
    writeHead(status: number) {
      this.statusCode = status;
    },
    end(body?: string) {
      if (body !== undefined) this.body = body;
    },
  };
  return res as unknown as MockResponse;
}

beforeEach(() => {
  resetSigningState();
  registerSigningKey({
    id: TEST_KEY_ID,
    algorithm: "HMAC-SHA256",
    secret: TEST_SECRET,
    createdAt: new Date().toISOString(),
    scopes: ["payments:write"],
  });
});

describe("requestSigningMiddleware", () => {
  it.each(["GET", "HEAD", "OPTIONS"])("skips signature enforcement for %s requests", async (method) => {
    const req = createMockReq({ method, url: "/api/v1/payments" });
    const res = createMockRes();
    const next = vi.fn();

    await requestSigningMiddleware()(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
  });

  it("returns 401 MISSING_SIGNATURE when required signature headers are absent", async () => {
    const req = createMockReq({ method: "POST", url: "/api/v1/payments", body: '{"amount":10}' });
    const res = createMockRes();
    const next = vi.fn();

    await requestSigningMiddleware()(req, res, next);

    expect(res.statusCode).toBe(401);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe("MISSING_SIGNATURE");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 INVALID_SIGNATURE when signature is tampered", async () => {
    const body = JSON.stringify({ amount: 100 });
    const signed = signRequest({
      method: "POST",
      path: "/api/v1/payments",
      body,
      keyId: TEST_KEY_ID,
      secret: TEST_SECRET,
    });

    const req = createMockReq({
      method: "POST",
      url: "/api/v1/payments",
      body,
      headers: {
        "x-signature-key-id": signed.keyId,
        "x-signature": Buffer.from("tampered-signature-bytes-0000000").toString("base64"),
        "x-signature-timestamp": signed.timestamp,
        "x-signature-nonce": signed.nonce,
      },
    });
    const res = createMockRes();
    const next = vi.fn();

    await requestSigningMiddleware()(req, res, next);

    expect(res.statusCode).toBe(401);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe("INVALID_SIGNATURE");
    expect(parsed.error.message).toBe("Signature mismatch");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 INVALID_SIGNATURE when body is tampered after signing", async () => {
    const signed = signRequest({
      method: "POST",
      path: "/api/v1/payments",
      body: JSON.stringify({ amount: 100 }),
      keyId: TEST_KEY_ID,
      secret: TEST_SECRET,
    });

    const req = createMockReq({
      method: "POST",
      url: "/api/v1/payments",
      body: JSON.stringify({ amount: 999999 }),
      headers: {
        "x-signature-key-id": signed.keyId,
        "x-signature": signed.signature,
        "x-signature-timestamp": signed.timestamp,
        "x-signature-nonce": signed.nonce,
      },
    });
    const res = createMockRes();
    const next = vi.fn();

    await requestSigningMiddleware()(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("INVALID_SIGNATURE");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 INVALID_SIGNATURE when the signing key is revoked", async () => {
    revokeSigningKey(TEST_KEY_ID);
    const body = JSON.stringify({ amount: 50 });
    const signed = signRequest({
      method: "POST",
      path: "/api/v1/payments",
      body,
      keyId: TEST_KEY_ID,
      secret: TEST_SECRET,
    });

    const req = createMockReq({
      method: "POST",
      url: "/api/v1/payments",
      body,
      headers: {
        "x-signature-key-id": signed.keyId,
        "x-signature": signed.signature,
        "x-signature-timestamp": signed.timestamp,
        "x-signature-nonce": signed.nonce,
      },
    });
    const res = createMockRes();
    const next = vi.fn();

    await requestSigningMiddleware()(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.message).toBe("Key has been revoked");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 INVALID_SIGNATURE on replay (reused nonce)", async () => {
    const body = JSON.stringify({ amount: 25 });
    const signed = signRequest({
      method: "POST",
      path: "/api/v1/payments",
      body,
      keyId: TEST_KEY_ID,
      secret: TEST_SECRET,
    });
    const headers = {
      "x-signature-key-id": signed.keyId,
      "x-signature": signed.signature,
      "x-signature-timestamp": signed.timestamp,
      "x-signature-nonce": signed.nonce,
    };

    const next1 = vi.fn();
    await requestSigningMiddleware()(
      createMockReq({ method: "POST", url: "/api/v1/payments", body, headers }),
      createMockRes(),
      next1,
    );
    expect(next1).toHaveBeenCalledTimes(1);

    const res2 = createMockRes();
    const next2 = vi.fn();
    await requestSigningMiddleware()(
      createMockReq({ method: "POST", url: "/api/v1/payments", body, headers }),
      res2,
      next2,
    );

    expect(res2.statusCode).toBe(401);
    expect(JSON.parse(res2.body).error.message).toContain("Nonce already used");
    expect(next2).not.toHaveBeenCalled();
  });

  it("calls next and attaches _rawBody for a validly signed request", async () => {
    const body = JSON.stringify({ amount: 42, currency: "USDC" });
    const signed = signRequest({
      method: "POST",
      path: "/api/v1/payments",
      query: { dryRun: "true" },
      body,
      keyId: TEST_KEY_ID,
      secret: TEST_SECRET,
    });

    const req = createMockReq({
      method: "POST",
      url: "/api/v1/payments?dryRun=true",
      body,
      headers: {
        "x-signature-key-id": signed.keyId,
        "x-signature": signed.signature,
        "x-signature-timestamp": signed.timestamp,
        "x-signature-nonce": signed.nonce,
      },
    });
    const res = createMockRes();
    const next = vi.fn();

    await requestSigningMiddleware()(req, res, next);

    expect(res.statusCode).toBe(0);
    expect(next).toHaveBeenCalledTimes(1);
    expect((req as any)._rawBody).toBe(body);
  });
});

describe("verifySignature and key lifecycle helpers", () => {
  it("rejects unknown key IDs", () => {
    const signed = signRequest({
      method: "POST",
      path: "/api/v1/payments",
      body: "{}",
      keyId: "unknown-key",
      secret: TEST_SECRET,
    });

    const result = verifySignature(signed);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Unknown key ID");
  });

  it("rejects expired signing keys", () => {
    registerSigningKey({
      id: "expired-key",
      algorithm: "HMAC-SHA256",
      secret: TEST_SECRET,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      scopes: [],
    });

    const signed = signRequest({
      method: "POST",
      path: "/api/v1/payments",
      body: "{}",
      keyId: "expired-key",
      secret: TEST_SECRET,
    });

    const result = verifySignature(signed);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Key has expired");
  });

  it("rejects timestamps outside the 5-minute tolerance window", () => {
    const signed = signRequest({
      method: "POST",
      path: "/api/v1/payments",
      body: "{}",
      keyId: TEST_KEY_ID,
      secret: TEST_SECRET,
    });
    signed.timestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const result = verifySignature(signed);
    expect(result.valid).toBe(false);
    expect(result.timestampValid).toBe(false);
    expect(result.error).toBe("Timestamp outside tolerance");
  });

  it("retrieves registered keys and cleans up expired nonces", () => {
    expect(getSigningKey(TEST_KEY_ID)?.id).toBe(TEST_KEY_ID);
    expect(cleanupExpiredNonces()).toBe(0);
  });
});
