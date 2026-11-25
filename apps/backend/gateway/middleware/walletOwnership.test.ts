import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

vi.mock("./auth.js", () => ({
  extractAuth: vi.fn(),
}));

vi.mock("../src/models/index.js", () => ({
  Wallet: {
    findByPk: vi.fn(),
  },
}));

import { extractAuth } from "./auth.js";
import { Wallet } from "../src/models/index.js";
import { checkWalletOwnership, requireWalletOwnership } from "./walletOwnership.js";

const mockedExtractAuth = vi.mocked(extractAuth);
const mockedFindByPk = vi.mocked(Wallet.findByPk);

type MockResponse = ServerResponse & {
  statusCode: number;
  body: string;
};

function createMockReq(): IncomingMessage {
  return {
    url: "/api/v1/wallets/wal-123",
    method: "GET",
    headers: {},
  } as unknown as IncomingMessage;
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
  vi.clearAllMocks();
});

describe("requireWalletOwnership", () => {
  it("returns 401 and false when the request is unauthenticated", async () => {
    mockedExtractAuth.mockReturnValue({ userId: undefined, token: undefined });
    const req = createMockReq();
    const res = createMockRes();

    const allowed = await requireWalletOwnership(req, res, "wal-123");

    expect(allowed).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.message).toContain("Authentication required");
    expect(mockedFindByPk).not.toHaveBeenCalled();
  });

  it("returns 404 and false when the wallet does not exist", async () => {
    mockedExtractAuth.mockReturnValue({ userId: "user-1", token: "tok" });
    mockedFindByPk.mockResolvedValue(null);
    const req = createMockReq();
    const res = createMockRes();

    const allowed = await requireWalletOwnership(req, res, "wal-missing");

    expect(mockedFindByPk).toHaveBeenCalledWith("wal-missing");
    expect(allowed).toBe(false);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.message).toContain("Wallet not found");
  });

  it("returns 403 and false when the wallet belongs to another user", async () => {
    mockedExtractAuth.mockReturnValue({ userId: "user-1", token: "tok" });
    mockedFindByPk.mockResolvedValue({ id: "wal-123", userId: "user-2" } as any);
    const req = createMockReq();
    const res = createMockRes();

    const allowed = await requireWalletOwnership(req, res, "wal-123");

    expect(allowed).toBe(false);
    expect(res.statusCode).toBe(403);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe("AUTHORIZATION_ERROR");
    expect(parsed.error.message).toContain("You do not own this wallet");
  });

  it("returns true without writing an error response when the user owns the wallet", async () => {
    mockedExtractAuth.mockReturnValue({ userId: "user-1", token: "tok" });
    mockedFindByPk.mockResolvedValue({ id: "wal-123", userId: "user-1" } as any);
    const req = createMockReq();
    const res = createMockRes();

    const allowed = await requireWalletOwnership(req, res, "wal-123");

    expect(allowed).toBe(true);
    expect(res.statusCode).toBe(0);
    expect(res.body).toBe("");
  });
});

describe("checkWalletOwnership", () => {
  it("returns owned: false when wallet does not exist", async () => {
    mockedFindByPk.mockResolvedValue(null);

    const result = await checkWalletOwnership("user-1", "wal-missing");

    expect(result).toEqual({
      userId: "user-1",
      walletId: "wal-missing",
      owned: false,
    });
  });

  it("returns owned: false when wallet belongs to another user", async () => {
    mockedFindByPk.mockResolvedValue({ id: "wal-123", userId: "user-2" } as any);

    const result = await checkWalletOwnership("user-1", "wal-123");

    expect(result).toEqual({
      userId: "user-1",
      walletId: "wal-123",
      owned: false,
    });
  });

  it("returns owned: true when wallet belongs to the user", async () => {
    mockedFindByPk.mockResolvedValue({ id: "wal-123", userId: "user-1" } as any);

    const result = await checkWalletOwnership("user-1", "wal-123");

    expect(result).toEqual({
      userId: "user-1",
      walletId: "wal-123",
      owned: true,
    });
  });
});
