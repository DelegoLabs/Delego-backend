import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDeliveryConfirmationWebhook } from "../escrow/autoSettlement.js";
import { registerRoutes } from "./routes.js";
import type { Route } from "@delegolabs/utils";

// Issue #24/#445 — POST /webhooks/delivery-confirmation accepted delivery
// confirmations with no signature verification at all: anyone who could
// reach it could forge a webhook and trigger escrow release. These tests
// cover the HMAC verification added to close that gap.

vi.mock("../escrow/autoSettlement.js", async () => {
  const actual = await vi.importActual<typeof import("../escrow/autoSettlement.js")>(
    "../escrow/autoSettlement.js"
  );
  return {
    ...actual,
    handleDeliveryConfirmationWebhook: vi.fn(),
  };
});

const SECRET = "test-webhook-secret";

type MockResponse = ServerResponse & { statusCode: number; body: string };

function createMockReq(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.headers = { "content-type": "application/json", ...headers };
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function createMockRes(): MockResponse {
  const res = {
    statusCode: 0,
    body: "",
    writeHead(status: number) {
      this.statusCode = status;
    },
    end(body?: string) {
      if (body !== undefined) this.body = body;
    },
  };
  return res as MockResponse;
}

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function findRoute(): Route {
  const route = registerRoutes().find(
    (r) => r.method === "POST" && r.pattern.test("/webhooks/delivery-confirmation")
  );
  if (!route) throw new Error("/webhooks/delivery-confirmation route not registered");
  return route;
}

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    webhookId: "wh_1",
    orderId: "order-1",
    escrowId: "escrow-1",
    escrowContractId: "CCONTRACTID000000000000000000000000000000000000000000000000",
    callerAddress: "GCALLERADDRESS0000000000000000000000000000000000000000000",
    confirmedAt: new Date().toISOString(),
    ...overrides,
  });
}

describe("POST /webhooks/delivery-confirmation", () => {
  beforeEach(() => {
    process.env.ESCROW_WEBHOOK_SECRET = SECRET;
    vi.mocked(handleDeliveryConfirmationWebhook).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ESCROW_WEBHOOK_SECRET;
  });

  it("returns 401 and never invokes the handler when the signature is invalid", async () => {
    const route = findRoute();
    const body = payload();
    const req = createMockReq(body, { "x-signature": "0".repeat(64) });
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("UNAUTHORIZED");
    expect(handleDeliveryConfirmationWebhook).not.toHaveBeenCalled();
  });

  it("returns 401 and never invokes the handler when the signature header is missing", async () => {
    const route = findRoute();
    const body = payload();
    const req = createMockReq(body);
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(401);
    expect(handleDeliveryConfirmationWebhook).not.toHaveBeenCalled();
  });

  it("returns 401 when the signature was computed over a different body (tampered payload)", async () => {
    const route = findRoute();
    const originalBody = payload();
    const tamperedBody = payload({ callerAddress: "GATTACKER00000000000000000000000000000000000000000000000" });
    // Signature is valid for originalBody, but the request carries tamperedBody.
    const req = createMockReq(tamperedBody, { "x-signature": sign(originalBody) });
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(401);
    expect(handleDeliveryConfirmationWebhook).not.toHaveBeenCalled();
  });

  it("returns 503 and never invokes the handler when the webhook secret is not configured", async () => {
    delete process.env.ESCROW_WEBHOOK_SECRET;
    const route = findRoute();
    const body = payload();
    const req = createMockReq(body, { "x-signature": sign(body) });
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe("CONFIG_ERROR");
    expect(handleDeliveryConfirmationWebhook).not.toHaveBeenCalled();
  });

  it("processes a validly signed request and releases escrow", async () => {
    vi.mocked(handleDeliveryConfirmationWebhook).mockResolvedValue({
      webhookId: "wh_1",
      orderId: "order-1",
      escrowId: "escrow-1",
      status: "released",
    });

    const route = findRoute();
    const body = payload();
    const req = createMockReq(body, { "x-signature": sign(body) });
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.data.status).toBe("released");
    expect(handleDeliveryConfirmationWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ webhookId: "wh_1", orderId: "order-1", escrowId: "escrow-1" })
    );
  });

  it("accepts the X-Webhook-Signature header name as documented in the issue", async () => {
    vi.mocked(handleDeliveryConfirmationWebhook).mockResolvedValue({
      webhookId: "wh_1",
      orderId: "order-1",
      escrowId: "escrow-1",
      status: "released",
    });

    const route = findRoute();
    const body = payload();
    const req = createMockReq(body, { "x-webhook-signature": sign(body) });
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(200);
  });

  it("accepts the sha256=<hex> prefixed signature style", async () => {
    vi.mocked(handleDeliveryConfirmationWebhook).mockResolvedValue({
      webhookId: "wh_1",
      orderId: "order-1",
      escrowId: "escrow-1",
      status: "released",
    });

    const route = findRoute();
    const body = payload();
    const req = createMockReq(body, { "x-hub-signature-256": `sha256=${sign(body)}` });
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(200);
  });

  it("returns 502 when the handler reports a failed release", async () => {
    vi.mocked(handleDeliveryConfirmationWebhook).mockResolvedValue({
      webhookId: "wh_1",
      orderId: "order-1",
      escrowId: "escrow-1",
      status: "failed",
      reason: "Release transaction failed",
    });

    const route = findRoute();
    const body = payload();
    const req = createMockReq(body, { "x-signature": sign(body) });
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(502);
  });

  it("returns 400 when required fields are missing, after a valid signature", async () => {
    const route = findRoute();
    const body = JSON.stringify({ webhookId: "wh_1" });
    const req = createMockReq(body, { "x-signature": sign(body) });
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(400);
    expect(handleDeliveryConfirmationWebhook).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON, after a valid signature over the raw bytes", async () => {
    const route = findRoute();
    const body = "{not valid json";
    const req = createMockReq(body, { "x-signature": sign(body) });
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(400);
    expect(handleDeliveryConfirmationWebhook).not.toHaveBeenCalled();
  });
});
