import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

vi.mock("./auth.js", () => ({
  extractAuth: vi.fn(),
}));

vi.mock("../src/models/index.js", () => ({
  Delegation: {
    findOne: vi.fn(),
  },
}));

import { extractAuth } from "./auth.js";
import { Delegation } from "../src/models/index.js";
import {
  verifyDelegationOwnership,
  getDelegationOwnershipContext,
  checkDelegationOwnership,
} from "./delegationOwnership.js";

const mockedExtractAuth = vi.mocked(extractAuth);
const mockedFindOne = vi.mocked(Delegation.findOne);

type MockResponse = ServerResponse & {
  statusCode: number;
  body: string;
};

function createMockReq(url = "/api/v1/delegations/del-123"): IncomingMessage {
  return {
    url,
    method: "PATCH",
    headers: { host: "localhost" },
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

describe("verifyDelegationOwnership", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    mockedExtractAuth.mockReturnValue({ userId: undefined, token: undefined });
    const req = createMockReq();
    const res = createMockRes();
    const next = vi.fn();

    await verifyDelegationOwnership()(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.message).toContain("Authentication required");
    expect(next).not.toHaveBeenCalled();
    expect(mockedFindOne).not.toHaveBeenCalled();
  });

  it("returns 404 when delegation ID is missing from URL", async () => {
    mockedExtractAuth.mockReturnValue({ userId: "user-1", token: "tok" });
    const req = createMockReq("/");
    const res = createMockRes();
    const next = vi.fn();

    await verifyDelegationOwnership()(req, res, next);

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.message).toContain("Delegation ID not provided");
    expect(next).not.toHaveBeenCalled();
    expect(mockedFindOne).not.toHaveBeenCalled();
  });

  it("returns 404 when the delegation does not exist", async () => {
    mockedExtractAuth.mockReturnValue({ userId: "user-1", token: "tok" });
    mockedFindOne.mockResolvedValue(null);
    const req = createMockReq("/api/v1/delegations/del-missing");
    const res = createMockRes();
    const next = vi.fn();

    await verifyDelegationOwnership()(req, res, next);

    expect(mockedFindOne).toHaveBeenCalledWith({ where: { id: "del-missing" } });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.message).toContain("Delegation not found");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when the delegation belongs to another user", async () => {
    mockedExtractAuth.mockReturnValue({ userId: "user-1", token: "tok" });
    mockedFindOne.mockResolvedValue({ id: "del-123", userId: "user-2" } as any);
    const req = createMockReq("/api/v1/delegations/del-123");
    const res = createMockRes();
    const next = vi.fn();

    await verifyDelegationOwnership()(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.message).toContain("do not have permission");
    expect(getDelegationOwnershipContext(req)).toEqual({
      userId: "user-1",
      delegationId: "del-123",
      owned: false,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next and attaches ownership context when the user owns the delegation", async () => {
    mockedExtractAuth.mockReturnValue({ userId: "user-1", token: "tok" });
    mockedFindOne.mockResolvedValue({ id: "del-123", userId: "user-1" } as any);
    const req = createMockReq("/api/v1/delegations/del-123");
    const res = createMockRes();
    const next = vi.fn();

    await verifyDelegationOwnership()(req, res, next);

    expect(res.statusCode).toBe(0);
    expect(getDelegationOwnershipContext(req)).toEqual({
      userId: "user-1",
      delegationId: "del-123",
      owned: true,
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("returns 403 when looking up the delegation throws an error", async () => {
    mockedExtractAuth.mockReturnValue({ userId: "user-1", token: "tok" });
    mockedFindOne.mockRejectedValue(new Error("DB connection failed"));
    const req = createMockReq("/api/v1/delegations/del-123");
    const res = createMockRes();
    const next = vi.fn();

    await verifyDelegationOwnership()(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.message).toContain("Failed to verify delegation ownership");
    expect(next).not.toHaveBeenCalled();
  });
});

describe("checkDelegationOwnership", () => {
  it("returns owned: false when delegation is not found", async () => {
    mockedFindOne.mockResolvedValue(null);

    const result = await checkDelegationOwnership("user-1", "del-missing");

    expect(result).toEqual({
      userId: "user-1",
      delegationId: "del-missing",
      owned: false,
    });
  });

  it("returns owned: false when delegation belongs to a different user", async () => {
    mockedFindOne.mockResolvedValue({ id: "del-123", userId: "user-2" } as any);

    const result = await checkDelegationOwnership("user-1", "del-123");

    expect(result).toEqual({
      userId: "user-1",
      delegationId: "del-123",
      owned: false,
    });
  });

  it("returns owned: true when delegation belongs to the user", async () => {
    mockedFindOne.mockResolvedValue({ id: "del-123", userId: "user-1" } as any);

    const result = await checkDelegationOwnership("user-1", "del-123");

    expect(result).toEqual({
      userId: "user-1",
      delegationId: "del-123",
      owned: true,
    });
  });
});
