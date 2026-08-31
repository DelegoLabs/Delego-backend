/**
 * Unit tests for #66 — audit log query API route protection and query
 * param handling. Mirrors routes/admin.test.ts's structure/mocking style.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { auditLogQueryHandler, auditLogVerifyHandler } from "./audit.js";

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("../middleware/auth.js", () => ({
  extractAuth: vi.fn(),
  getAuthenticatedUserContext: vi.fn(),
}));

vi.mock("@delegolabs/utils", async () => {
  const actual = await vi.importActual<typeof import("@delegolabs/utils")>("@delegolabs/utils");
  return {
    ...actual,
    queryAuditLog: vi.fn().mockResolvedValue({ entries: [], nextCursor: null }),
    getChainSegment: vi.fn().mockResolvedValue([]),
    verifyChain: vi.fn().mockReturnValue({
      valid: true,
      entriesChecked: 0,
      firstBrokenEntryId: null,
      reason: null,
    }),
  };
});

import { extractAuth, getAuthenticatedUserContext } from "../middleware/auth.js";
import { queryAuditLog, getChainSegment, verifyChain } from "@delegolabs/utils";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(url = "/api/v1/admin/audit-log"): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.headers = { host: "localhost" };
  req.url = url;
  req.method = "GET";
  return req;
}

function makeRes(): ServerResponse & { _body: string; _status: number } {
  const res: any = new EventEmitter();
  res._body = "";
  res._status = 0;
  res._headers = {} as Record<string, string>;
  res.statusCode = 200;
  res.setHeader = (k: string, v: string) => { res._headers[k] = v; };
  res.getHeader = (k: string) => res._headers[k];
  res.removeHeader = (_k: string) => {};
  res.writeHead = (status: number, headers?: Record<string, string>) => {
    res.statusCode = status;
    res._status = status;
    if (headers) Object.assign(res._headers, headers);
  };
  res.write = (chunk: string) => { res._body += chunk; return true; };
  res.end = (chunk?: string) => {
    if (chunk) res._body += chunk;
    res._status = res.statusCode;
  };
  return res;
}

function mockAdmin() {
  vi.mocked(extractAuth).mockReturnValue({ userId: "admin-1", token: "tok" });
  vi.mocked(getAuthenticatedUserContext).mockReturnValue({
    userId: "admin-1",
    email: "admin@example.com",
    roles: ["admin"],
  });
}

function mockNonAdmin() {
  vi.mocked(extractAuth).mockReturnValue({ userId: "user-1", token: "tok" });
  vi.mocked(getAuthenticatedUserContext).mockReturnValue({
    userId: "user-1",
    email: "user@example.com",
    roles: ["user"],
  });
}

function mockUnauthenticated() {
  vi.mocked(extractAuth).mockReturnValue({ userId: null, token: null });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("auditLogQueryHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when the request is unauthenticated", async () => {
    mockUnauthenticated();
    const res = makeRes();
    await auditLogQueryHandler(makeReq(), res as any);
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 when the user is authenticated but not an admin", async () => {
    mockNonAdmin();
    const res = makeRes();
    await auditLogQueryHandler(makeReq(), res as any);
    expect(res.statusCode).toBe(403);
  });

  it("returns 200 with query results for an admin", async () => {
    mockAdmin();
    const res = makeRes();
    await auditLogQueryHandler(makeReq(), res as any);
    expect(res.statusCode).toBe(200);
    expect(queryAuditLog).toHaveBeenCalled();
  });

  it("passes filters through to queryAuditLog", async () => {
    mockAdmin();
    const res = makeRes();
    await auditLogQueryHandler(
      makeReq("/api/v1/admin/audit-log?tableName=users&recordId=u1&operation=UPDATE&userId=admin-2&limit=5&sort=asc"),
      res as any
    );
    expect(res.statusCode).toBe(200);
    expect(queryAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tableName: "users",
        recordId: "u1",
        operation: "UPDATE",
        userId: "admin-2",
        limit: 5,
        sort: "asc",
      })
    );
  });

  it("rejects an invalid operation value", async () => {
    mockAdmin();
    const res = makeRes();
    await auditLogQueryHandler(makeReq("/api/v1/admin/audit-log?operation=FOO"), res as any);
    expect(res.statusCode).toBe(400);
    expect(queryAuditLog).not.toHaveBeenCalled();
  });

  it("rejects an invalid sort value", async () => {
    mockAdmin();
    const res = makeRes();
    await auditLogQueryHandler(makeReq("/api/v1/admin/audit-log?sort=sideways"), res as any);
    expect(res.statusCode).toBe(400);
  });

  it("rejects a limit outside 1-100", async () => {
    mockAdmin();
    const res = makeRes();
    await auditLogQueryHandler(makeReq("/api/v1/admin/audit-log?limit=0"), res as any);
    expect(res.statusCode).toBe(400);

    const res2 = makeRes();
    await auditLogQueryHandler(makeReq("/api/v1/admin/audit-log?limit=101"), res2 as any);
    expect(res2.statusCode).toBe(400);
  });

  it("rejects a non-integer limit", async () => {
    mockAdmin();
    const res = makeRes();
    await auditLogQueryHandler(makeReq("/api/v1/admin/audit-log?limit=abc"), res as any);
    expect(res.statusCode).toBe(400);
  });

  it("rejects a malformed 'from' timestamp", async () => {
    mockAdmin();
    const res = makeRes();
    await auditLogQueryHandler(makeReq("/api/v1/admin/audit-log?from=not-a-date"), res as any);
    expect(res.statusCode).toBe(400);
  });

  it("rejects a malformed 'to' timestamp", async () => {
    mockAdmin();
    const res = makeRes();
    await auditLogQueryHandler(makeReq("/api/v1/admin/audit-log?to=not-a-date"), res as any);
    expect(res.statusCode).toBe(400);
  });

  it("accepts valid from/to ISO timestamps", async () => {
    mockAdmin();
    const res = makeRes();
    await auditLogQueryHandler(
      makeReq("/api/v1/admin/audit-log?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z"),
      res as any
    );
    expect(res.statusCode).toBe(200);
    expect(queryAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        from: new Date("2026-01-01T00:00:00Z"),
        to: new Date("2026-02-01T00:00:00Z"),
      })
    );
  });

  it("returns 500 when the store throws", async () => {
    mockAdmin();
    vi.mocked(queryAuditLog).mockRejectedValueOnce(new Error("db unreachable"));
    const res = makeRes();
    await auditLogQueryHandler(makeReq(), res as any);
    expect(res.statusCode).toBe(500);
  });
});

describe("auditLogVerifyHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    mockUnauthenticated();
    const res = makeRes();
    await auditLogVerifyHandler(makeReq("/api/v1/admin/audit-log/verify"), res as any);
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for a non-admin", async () => {
    mockNonAdmin();
    const res = makeRes();
    await auditLogVerifyHandler(makeReq("/api/v1/admin/audit-log/verify"), res as any);
    expect(res.statusCode).toBe(403);
  });

  it("returns 200 with the verification result for an admin", async () => {
    mockAdmin();
    const res = makeRes();
    await auditLogVerifyHandler(makeReq("/api/v1/admin/audit-log/verify"), res as any);
    expect(res.statusCode).toBe(200);
    expect(getChainSegment).toHaveBeenCalled();
    expect(verifyChain).toHaveBeenCalled();
  });

  it("reports a broken chain as-is (does not itself error on invalid: false)", async () => {
    mockAdmin();
    vi.mocked(verifyChain).mockReturnValueOnce({
      valid: false,
      entriesChecked: 2,
      firstBrokenEntryId: "audit-3",
      reason: "entryHash mismatch",
    });
    const res = makeRes();
    await auditLogVerifyHandler(makeReq("/api/v1/admin/audit-log/verify"), res as any);
    expect(res.statusCode).toBe(200);
    expect(res._body).toContain("audit-3");
  });

  it("returns 500 when the store throws", async () => {
    mockAdmin();
    vi.mocked(getChainSegment).mockRejectedValueOnce(new Error("db unreachable"));
    const res = makeRes();
    await auditLogVerifyHandler(makeReq("/api/v1/admin/audit-log/verify"), res as any);
    expect(res.statusCode).toBe(500);
  });

  it("rejects a malformed 'from' timestamp", async () => {
    mockAdmin();
    const res = makeRes();
    await auditLogVerifyHandler(
      makeReq("/api/v1/admin/audit-log/verify?from=garbage"),
      res as any
    );
    expect(res.statusCode).toBe(400);
  });
});
