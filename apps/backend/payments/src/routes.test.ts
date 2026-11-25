/**
 * Unit tests for the request body size limit on readJsonBody (#28).
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { registerRoutes } from "./routes.js";
import type { Route } from "@delegolabs/utils";

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

function findInitializeRoute(): Route {
  const route = registerRoutes().find(
    (r) => r.method === "POST" && r.pattern.test("/escrow/initialize")
  );
  if (!route) throw new Error("escrow/initialize route not registered");
  return route;
}

function findHealthRoute(): Route {
  const route = registerRoutes().find(
    (candidate) => candidate.method === "GET" && candidate.pattern.test("/health"),
  );
  if (!route) throw new Error("health route not registered");
  return route;
}

describe("GET /health", () => {
  it("returns the standard health status and an ISO timestamp", async () => {
    const route = findHealthRoute();
    const res = createMockRes();

    await route.handler({} as IncomingMessage, res, {});

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
    expect(Object.keys(body).sort()).toEqual(["status", "timestamp"]);
  });
});

describe("POST /escrow/initialize body size limit", () => {
  it("reads and parses a body under the 1MB limit (no 413)", async () => {
    const route = findInitializeRoute();
    const req = createMockReq(JSON.stringify({}));
    const res = createMockRes();

    await route.handler(req, res, {});

    // Body was parsed successfully; request fails validation for missing
    // fields (400 VALIDATION_ERROR), not size (413).
    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).not.toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects a body over the 1MB limit with 413 Payload Too Large", async () => {
    const route = findInitializeRoute();
    const oversizedBody = JSON.stringify({ padding: "a".repeat(1024 * 1024 + 1) });
    const req = createMockReq(oversizedBody);
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(413);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(parsed.error.message).toContain("1048576");
  });
});

function findTaxCalculateRoute(): Route {
  const route = registerRoutes().find(
    (candidate) =>
      candidate.method === "POST" && candidate.pattern.test("/api/v1/payments/tax/calculate"),
  );
  if (!route) throw new Error("POST /api/v1/payments/tax/calculate route not registered");
  return route;
}

describe("POST /api/v1/payments/tax/calculate", () => {
  it("calculates EU B2C VAT for valid params", async () => {
    const route = findTaxCalculateRoute();
    const req = createMockReq(
      JSON.stringify({
        buyerCountry: "DE",
        buyerPostalCode: "10115",
        merchantCountry: "US",
        merchantPostalCode: "94107",
        itemCategory: "physical_goods",
        amountStroops: "10000000",
      }),
    );
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toBeNull();
    expect(parsed.data).toEqual({
      taxJurisdiction: "DE",
      taxRateBasisPoints: 1900,
      taxAmountStroops: "1900000",
      isReverseCharge: false,
    });
  });

  it("applies EU B2B reverse charge when valid buyerVatId is provided", async () => {
    const route = findTaxCalculateRoute();
    const req = createMockReq(
      JSON.stringify({
        buyerCountry: "DE",
        buyerPostalCode: "10115",
        merchantCountry: "US",
        merchantPostalCode: "94107",
        itemCategory: "digital",
        amountStroops: "10000000",
        buyerVatId: "DE123456789",
      }),
    );
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toBeNull();
    expect(parsed.data).toEqual({
      taxJurisdiction: "DE",
      taxRateBasisPoints: 0,
      taxAmountStroops: "0",
      isReverseCharge: true,
    });
  });

  it("returns 400 VALIDATION_ERROR when required fields are missing or invalid", async () => {
    const route = findTaxCalculateRoute();
    const req = createMockReq(
      JSON.stringify({
        buyerCountry: "INVALID",
        buyerPostalCode: "10115",
        merchantCountry: "US",
        merchantPostalCode: "94107",
        itemCategory: "physical_goods",
        amountStroops: "10000000",
      }),
    );
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.data).toBeNull();
    expect(parsed.error.code).toBe("VALIDATION_ERROR");
    expect(parsed.error.details).toEqual({ field: "buyerCountry" });
  });

  it("returns 400 TAX_CALCULATION_FAILED for invalid JSON", async () => {
    const route = findTaxCalculateRoute();
    const req = createMockReq("{not-json");
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.data).toBeNull();
    expect(parsed.error.code).toBe("TAX_CALCULATION_FAILED");
  });

  it("returns 413 PAYLOAD_TOO_LARGE when body exceeds limit", async () => {
    const route = findTaxCalculateRoute();
    const oversizedBody = JSON.stringify({ padding: "a".repeat(1024 * 1024 + 1) });
    const req = createMockReq(oversizedBody);
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(413);
    const parsed = JSON.parse(res.body);
    expect(parsed.data).toBeNull();
    expect(parsed.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});
