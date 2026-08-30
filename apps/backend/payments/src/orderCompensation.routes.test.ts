/**
 * Route tests for #35 — POST /api/v1/orders/:orderId/release and
 * POST /api/v1/orders/:orderId/refund, the order-level compensation endpoints
 * the orchestrator's saga compensation steps call.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Route } from "@delegolabs/utils";

vi.mock("../settlement/index.js", () => ({
  settleOrder: vi.fn(),
  refundOrder: vi.fn(),
}));

import { registerRoutes } from "./routes.js";
import { settleOrder, refundOrder } from "../settlement/index.js";

type MockResponse = ServerResponse & { statusCode: number; body: string };

function createMockReq(body: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.headers = { "content-type": "application/json" };
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

function findRoute(method: string, testPath: string): Route {
  const found = registerRoutes().find((r) => r.method === method && r.pattern.test(testPath));
  if (!found) throw new Error(`Route not registered for ${method} ${testPath}`);
  return found;
}

function extractParams(r: Route, testPath: string): Record<string, string> {
  const match = testPath.match(r.pattern)!;
  const params: Record<string, string> = {};
  r.paramNames.forEach((name, i) => {
    params[name] = match[i + 1] ?? "";
  });
  return params;
}

describe("POST /api/v1/orders/:orderId/release", () => {
  beforeEach(() => {
    vi.mocked(settleOrder).mockReset();
    vi.mocked(refundOrder).mockReset();
  });

  it("returns 200 with the settlement outcome on success", async () => {
    vi.mocked(settleOrder).mockResolvedValue({
      orderId: "order-1",
      escrowId: "42",
      status: "released",
      txHash: "tx-1",
      alreadySettled: false,
    });

    const testPath = "/api/v1/orders/order-1/release";
    const r = findRoute("POST", testPath);
    const req = createMockReq("{}");
    const res = createMockRes();

    await r.handler(req, res, extractParams(r, testPath));

    expect(settleOrder).toHaveBeenCalledWith("order-1");
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.data.status).toBe("released");
    expect(parsed.error).toBeNull();
  });

  it("returns 502 when settleOrder reports a failed outcome", async () => {
    vi.mocked(settleOrder).mockResolvedValue({
      orderId: "order-1",
      escrowId: "42",
      status: "failed",
      txHash: null,
      alreadySettled: false,
      reason: "Release transaction failed on-chain",
    });

    const testPath = "/api/v1/orders/order-1/release";
    const r = findRoute("POST", testPath);
    const req = createMockReq("{}");
    const res = createMockRes();

    await r.handler(req, res, extractParams(r, testPath));

    expect(res.statusCode).toBe(502);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe("ORDER_RELEASE_FAILED");
  });

  it("returns 200 with alreadySettled:true when settleOrder is called twice for the same order (idempotency)", async () => {
    vi.mocked(settleOrder).mockResolvedValue({
      orderId: "order-1",
      escrowId: "42",
      status: "released",
      txHash: "tx-1",
      alreadySettled: true,
    });

    const testPath = "/api/v1/orders/order-1/release";
    const r = findRoute("POST", testPath);
    const res = createMockRes();
    await r.handler(createMockReq("{}"), res, extractParams(r, testPath));

    const parsed = JSON.parse(res.body);
    expect(parsed.data.alreadySettled).toBe(true);
  });

  it("returns 400 (via sendOperationError) when settleOrder throws (e.g. misconfiguration)", async () => {
    vi.mocked(settleOrder).mockRejectedValue(new Error("SETTLEMENT_SOURCE_ADDRESS environment variable is not configured"));

    const testPath = "/api/v1/orders/order-1/release";
    const r = findRoute("POST", testPath);
    const res = createMockRes();
    await r.handler(createMockReq("{}"), res, extractParams(r, testPath));

    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe("ORDER_RELEASE_FAILED");
  });
});

describe("POST /api/v1/orders/:orderId/refund", () => {
  beforeEach(() => {
    vi.mocked(settleOrder).mockReset();
    vi.mocked(refundOrder).mockReset();
  });

  it("returns 200 with the refund outcome on success", async () => {
    vi.mocked(refundOrder).mockResolvedValue({
      orderId: "order-1",
      escrowId: "42",
      status: "refunded",
      txHash: "tx-2",
      alreadySettled: false,
    });

    const testPath = "/api/v1/orders/order-1/refund";
    const r = findRoute("POST", testPath);
    const req = createMockReq(JSON.stringify({ refundReasonCode: "merchant_cancelled" }));
    const res = createMockRes();

    await r.handler(req, res, extractParams(r, testPath));

    expect(refundOrder).toHaveBeenCalledWith("order-1", "merchant_cancelled");
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.data.status).toBe("refunded");
  });

  it("returns 400 when refundReasonCode is missing", async () => {
    const testPath = "/api/v1/orders/order-1/refund";
    const r = findRoute("POST", testPath);
    const req = createMockReq("{}");
    const res = createMockRes();

    await r.handler(req, res, extractParams(r, testPath));

    expect(res.statusCode).toBe(400);
    expect(refundOrder).not.toHaveBeenCalled();
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when refundReasonCode is not one of the accepted values", async () => {
    const testPath = "/api/v1/orders/order-1/refund";
    const r = findRoute("POST", testPath);
    const req = createMockReq(JSON.stringify({ refundReasonCode: "not_a_real_reason" }));
    const res = createMockRes();

    await r.handler(req, res, extractParams(r, testPath));

    expect(res.statusCode).toBe(400);
    expect(refundOrder).not.toHaveBeenCalled();
  });

  it("returns 502 when refundOrder reports a failed outcome", async () => {
    vi.mocked(refundOrder).mockResolvedValue({
      orderId: "order-1",
      escrowId: "42",
      status: "failed",
      txHash: null,
      alreadySettled: false,
      reason: "Refund transaction failed on-chain",
    });

    const testPath = "/api/v1/orders/order-1/refund";
    const r = findRoute("POST", testPath);
    const req = createMockReq(JSON.stringify({ refundReasonCode: "timeout" }));
    const res = createMockRes();

    await r.handler(req, res, extractParams(r, testPath));

    expect(res.statusCode).toBe(502);
  });

  it("returns 400 with VALIDATION_ERROR when the request body is invalid JSON", async () => {
    const testPath = "/api/v1/orders/order-1/refund";
    const r = findRoute("POST", testPath);
    const req = createMockReq("not json");
    const res = createMockRes();

    await r.handler(req, res, extractParams(r, testPath));

    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe("VALIDATION_ERROR");
  });
});
