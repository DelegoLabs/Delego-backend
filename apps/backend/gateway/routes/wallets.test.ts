import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getWalletHandler } from "./wallets.js";

const { extractAuth, requireWalletOwnership, findByPk } = vi.hoisted(() => ({
  extractAuth: vi.fn(),
  requireWalletOwnership: vi.fn(),
  findByPk: vi.fn(),
}));

vi.mock("../middleware/auth.js", () => ({
  extractAuth,
}));

vi.mock("../middleware/walletOwnership.js", () => ({
  requireWalletOwnership,
}));

vi.mock("../src/models/index.js", () => ({
  Wallet: { findByPk },
}));

type MockResponse = ServerResponse & {
  statusCode: number;
  body: string;
  headersSent: boolean;
  setHeader(name: string, value: string | number): void;
  writeHead(status: number): void;
  end(body?: string): void;
};

function createResponse(): MockResponse {
  return {
    statusCode: 0,
    body: "",
    headersSent: false,
    setHeader() {},
    writeHead(status: number) {
      this.statusCode = status;
      this.headersSent = true;
    },
    end(body?: string) {
      if (body) this.body = body;
    },
  } as MockResponse;
}

function createRequest(): IncomingMessage {
  return new EventEmitter() as IncomingMessage;
}

describe("GET /api/v1/wallets/:walletId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extractAuth.mockReturnValue({ userId: "user-123", token: "jwt-token" });
    requireWalletOwnership.mockResolvedValue(true);
  });

  it("stops early when wallet ownership/auth guard rejects the request", async () => {
    requireWalletOwnership.mockResolvedValue(false);
    const req = createRequest();
    const res = createResponse();

    await getWalletHandler(req, res, { walletId: "wallet-1" });

    expect(requireWalletOwnership).toHaveBeenCalledWith(req, res, "wallet-1");
    expect(findByPk).not.toHaveBeenCalled();
    expect(res.headersSent).toBe(false);
  });

  it("returns 200 with wallet details when ownership check passes", async () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const updatedAt = new Date("2026-01-02T12:30:00.000Z");
    findByPk.mockResolvedValue({
      id: "wallet-1",
      stellarAddress: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
      publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
      network: "testnet",
      createdAt,
      updatedAt,
    });

    const req = createRequest();
    const res = createResponse();

    await getWalletHandler(req, res, { walletId: "wallet-1" });

    expect(requireWalletOwnership).toHaveBeenCalledWith(req, res, "wallet-1");
    expect(findByPk).toHaveBeenCalledWith("wallet-1");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      data: {
        id: "wallet-1",
        userId: "user-123",
        stellarAddress: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
        publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
        network: "testnet",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T12:30:00.000Z",
      },
      error: null,
    });
  });

  it("returns early without sending a response if wallet disappears after ownership check", async () => {
    findByPk.mockResolvedValue(null);
    const req = createRequest();
    const res = createResponse();

    await getWalletHandler(req, res, { walletId: "wallet-missing" });

    expect(findByPk).toHaveBeenCalledWith("wallet-missing");
    expect(res.headersSent).toBe(false);
    expect(res.body).toBe("");
  });

  it("propagates upstream errors from requireWalletOwnership", async () => {
    requireWalletOwnership.mockRejectedValue(new Error("DB connection lost"));
    const req = createRequest();
    const res = createResponse();

    await expect(
      getWalletHandler(req, res, { walletId: "wallet-1" }),
    ).rejects.toThrow("DB connection lost");
    expect(findByPk).not.toHaveBeenCalled();
  });

  it("propagates upstream errors from Wallet.findByPk", async () => {
    findByPk.mockRejectedValue(new Error("Query timeout"));
    const req = createRequest();
    const res = createResponse();

    await expect(
      getWalletHandler(req, res, { walletId: "wallet-1" }),
    ).rejects.toThrow("Query timeout");
    expect(res.headersSent).toBe(false);
  });
});
