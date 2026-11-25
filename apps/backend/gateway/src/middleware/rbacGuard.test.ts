/**
 * Unit tests for #618 — role-based authorization guard for merchant staff
 * accounts.
 *
 * Covers role -> permission-scope resolution and the 401/403/next-handler
 * paths of `requireMerchantPermission()` / `guardMerchantPermission()`,
 * including the acceptance-criteria scenario: catalog editors must not be
 * able to trigger financial endpoints (refunds, payouts), while owners
 * retain full access.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

vi.mock("../../middleware/auth.js", () => ({
  extractAuth: vi.fn(),
}));

vi.mock("../models/index.js", () => ({
  Merchant: { findByPk: vi.fn() },
}));

import { extractAuth } from "../../middleware/auth.js";
import { Merchant } from "../models/index.js";
import {
  ALL_PERMISSION_SCOPES,
  ROLE_PERMISSION_SCOPES,
  resolvePermissionScopes,
  hasPermissionScope,
  setMerchantStaffRoles,
  removeMerchantStaffMember,
  getMerchantStaffRoles,
  getMerchantStaffMember,
  resolveMerchantId,
  requireMerchantPermission,
  guardMerchantPermission,
} from "./rbacGuard.js";

const mockedExtractAuth = vi.mocked(extractAuth);
const mockedFindByPk = vi.mocked(Merchant.findByPk);

type MockResponse = ServerResponse & { statusCode: number; body: string };

function createMockReq(headers: Record<string, string | string[]> = {}): IncomingMessage {
  return { url: "/api/v1/merchants/m-1/payouts", method: "POST", headers } as unknown as IncomingMessage;
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
  removeMerchantStaffMember("m-1", "user-1");
  removeMerchantStaffMember("m-1", "user-2");
});

describe("resolvePermissionScopes / hasPermissionScope", () => {
  it("grants owners every permission scope", () => {
    expect(resolvePermissionScopes(["owner"])).toEqual([...ALL_PERMISSION_SCOPES]);
  });

  it("denies catalog editors financial scopes", () => {
    const scopes = resolvePermissionScopes(["catalog_editor"]);
    expect(scopes).toEqual(["catalog:write", "catalog:read"]);
    expect(scopes).not.toContain("orders:refund");
    expect(scopes).not.toContain("payouts:withdraw");
  });

  it("restricts financial auditors to read-only catalog access", () => {
    expect(resolvePermissionScopes(["financial_auditor"])).toEqual(["catalog:read"]);
  });

  it("lets support agents read the catalog and issue refunds, but not withdraw payouts", () => {
    const scopes = resolvePermissionScopes(["support_agent"]);
    expect(scopes).toEqual(["catalog:read", "orders:refund"]);
    expect(scopes).not.toContain("payouts:withdraw");
  });

  it("excludes payout withdrawal from admin access", () => {
    expect(resolvePermissionScopes(["admin"])).not.toContain("payouts:withdraw");
  });

  it("unions scopes across multiple assigned roles", () => {
    expect(resolvePermissionScopes(["catalog_editor", "support_agent"])).toEqual([
      "catalog:write",
      "catalog:read",
      "orders:refund",
    ]);
  });

  it("returns no scopes for an empty or missing role list", () => {
    expect(resolvePermissionScopes([])).toEqual([]);
    expect(resolvePermissionScopes(undefined)).toEqual([]);
  });

  it("hasPermissionScope reflects the resolved scope set", () => {
    expect(hasPermissionScope({ roles: ["catalog_editor"] }, "catalog:write")).toBe(true);
    expect(hasPermissionScope({ roles: ["catalog_editor"] }, "payouts:withdraw")).toBe(false);
    expect(hasPermissionScope(null, "catalog:read")).toBe(false);
  });

  it("every declared role maps to a subset of the known scopes", () => {
    for (const role of Object.keys(ROLE_PERMISSION_SCOPES) as (keyof typeof ROLE_PERMISSION_SCOPES)[]) {
      for (const scope of ROLE_PERMISSION_SCOPES[role]) {
        expect(ALL_PERMISSION_SCOPES).toContain(scope);
      }
    }
  });
});

describe("merchant staff directory", () => {
  it("stores and retrieves explicit role assignments", () => {
    setMerchantStaffRoles("m-1", "user-1", ["catalog_editor"]);
    expect(getMerchantStaffRoles("m-1", "user-1")).toEqual(["catalog_editor"]);

    removeMerchantStaffMember("m-1", "user-1");
    expect(getMerchantStaffRoles("m-1", "user-1")).toBeUndefined();
  });

  it("resolves explicit staff roles before falling back to merchant ownership", async () => {
    setMerchantStaffRoles("m-1", "user-1", ["financial_auditor"]);
    const member = await getMerchantStaffMember("m-1", "user-1");
    expect(member).toEqual({ userId: "user-1", merchantId: "m-1", roles: ["financial_auditor"] });
    expect(mockedFindByPk).not.toHaveBeenCalled();
  });

  it("implicitly grants the owner role to the merchant's ownerUserId", async () => {
    mockedFindByPk.mockResolvedValue({ id: "m-1", ownerUserId: "user-2" } as any);
    const member = await getMerchantStaffMember("m-1", "user-2");
    expect(member).toEqual({ userId: "user-2", merchantId: "m-1", roles: ["owner"] });
  });

  it("returns null when the user has no staff role and does not own the merchant", async () => {
    mockedFindByPk.mockResolvedValue({ id: "m-1", ownerUserId: "someone-else" } as any);
    const member = await getMerchantStaffMember("m-1", "user-1");
    expect(member).toBeNull();
  });
});

describe("resolveMerchantId", () => {
  it("prefers the merchantId route param", () => {
    expect(resolveMerchantId(createMockReq(), { merchantId: "m-1", id: "ignored" })).toBe("m-1");
  });

  it("falls back to the id route param", () => {
    expect(resolveMerchantId(createMockReq(), { id: "m-2" })).toBe("m-2");
  });

  it("falls back to the x-merchant-id header", () => {
    expect(resolveMerchantId(createMockReq({ "x-merchant-id": "m-3" }))).toBe("m-3");
  });

  it("returns null when no merchant id can be resolved", () => {
    expect(resolveMerchantId(createMockReq())).toBeNull();
  });
});

describe("requireMerchantPermission", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    mockedExtractAuth.mockReturnValue({ userId: null, token: null });
    const res = createMockRes();

    const authorized = await requireMerchantPermission(createMockReq(), res, "m-1", "payouts:withdraw");

    expect(authorized).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 when no merchant id was resolved", async () => {
    mockedExtractAuth.mockReturnValue({ userId: "user-1", token: "t" });
    const res = createMockRes();

    const authorized = await requireMerchantPermission(createMockReq(), res, null, "catalog:read");

    expect(authorized).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 (not 500) when a catalog editor attempts to withdraw a payout", async () => {
    mockedExtractAuth.mockReturnValue({ userId: "user-1", token: "t" });
    setMerchantStaffRoles("m-1", "user-1", ["catalog_editor"]);
    const res = createMockRes();

    const authorized = await requireMerchantPermission(createMockReq(), res, "m-1", "payouts:withdraw");

    expect(authorized).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN");
  });

  it("returns 403 when a catalog editor attempts to process a refund", async () => {
    mockedExtractAuth.mockReturnValue({ userId: "user-1", token: "t" });
    setMerchantStaffRoles("m-1", "user-1", ["catalog_editor"]);
    const res = createMockRes();

    const authorized = await requireMerchantPermission(createMockReq(), res, "m-1", "orders:refund");

    expect(authorized).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("grants merchant owners full access across all operations", async () => {
    mockedExtractAuth.mockReturnValue({ userId: "user-2", token: "t" });
    mockedFindByPk.mockResolvedValue({ id: "m-1", ownerUserId: "user-2" } as any);

    for (const scope of ALL_PERMISSION_SCOPES) {
      const res = createMockRes();
      const authorized = await requireMerchantPermission(createMockReq(), res, "m-1", scope);
      expect(authorized).toBe(true);
    }
  });
});

describe("guardMerchantPermission", () => {
  it("invokes the wrapped handler when authorized", async () => {
    mockedExtractAuth.mockReturnValue({ userId: "user-1", token: "t" });
    setMerchantStaffRoles("m-1", "user-1", ["catalog_editor"]);
    const handler = vi.fn();
    const guarded = guardMerchantPermission("catalog:write", handler);
    const res = createMockRes();

    await guarded(createMockReq(), res, { merchantId: "m-1" });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("blocks the wrapped handler with 403 when the scope is missing", async () => {
    mockedExtractAuth.mockReturnValue({ userId: "user-1", token: "t" });
    setMerchantStaffRoles("m-1", "user-1", ["catalog_editor"]);
    const handler = vi.fn();
    const guarded = guardMerchantPermission("payouts:withdraw", handler);
    const res = createMockRes();

    await guarded(createMockReq(), res, { merchantId: "m-1" });

    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
