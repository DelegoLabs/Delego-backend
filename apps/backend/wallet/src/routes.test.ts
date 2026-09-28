/**
 * Unit tests for the request body size limit on readJsonBody (#29).
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
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

function findSimulateRoute(): Route {
  const route = registerRoutes().find(
    (r) => r.method === "POST" && r.pattern.test("/transactions/simulate")
  );
  if (!route) throw new Error("transactions/simulate route not registered");
  return route;
}

describe("POST /transactions/simulate body size limit", () => {
  it("reads and parses a body under the 1MB limit (no 413)", async () => {
    const route = findSimulateRoute();
    const req = createMockReq(JSON.stringify({}));
    const res = createMockRes();

    await route.handler(req, res, {});

    // Body was parsed successfully; request fails validation for missing
    // fields (400 SIMULATION_FAILED), not size (413).
    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe("SIMULATION_FAILED");
  });

  it("rejects a body over the 1MB limit with 413 Payload Too Large", async () => {
    const route = findSimulateRoute();
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

describe("POST /wallets/simulate", () => {
  function findWalletSimulateRoute(simulator: { simulateTransaction: ReturnType<typeof vi.fn> }): Route {
    const route = registerRoutes(simulator as never).find(
      (candidate) => candidate.method === "POST" && candidate.pattern.test("/wallets/simulate"),
    );
    if (!route) throw new Error("wallets/simulate route not registered");
    return route;
  }

  it("parses valid XDR and returns the simulator result", async () => {
    const source = Keypair.random().publicKey();
    const destination = Keypair.random().publicKey();
    const transactionXdr = new TransactionBuilder(new Account(source, "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.payment({ destination, asset: Asset.native(), amount: "1" }))
      .setTimeout(30)
      .build()
      .toXDR();
    const simulator = {
      simulateTransaction: vi.fn().mockResolvedValue({
        results: [],
        minResourceFee: "100",
        transactionData: { toXDR: () => Buffer.from("footprint") },
      }),
    };
    const route = findWalletSimulateRoute(simulator);
    const req = createMockReq(JSON.stringify({ xdr: transactionXdr }));
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(simulator.simulateTransaction).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toEqual({
      success: true,
      minResourceFee: "100",
      footprint: Buffer.from("footprint").toString("base64"),
    });
  });

  it("rejects invalid XDR with HTTP 400 without invoking simulation", async () => {
    const simulator = { simulateTransaction: vi.fn() };
    const route = findWalletSimulateRoute(simulator);
    const req = createMockReq(JSON.stringify({ xdr: "not-valid-xdr" }));
    const res = createMockRes();

    await route.handler(req, res, {});

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.message).toContain("Invalid transaction XDR");
    expect(simulator.simulateTransaction).not.toHaveBeenCalled();
  });
});
