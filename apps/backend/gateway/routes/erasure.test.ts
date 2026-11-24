import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, expect, it, vi } from "vitest";
import { QueryTypes } from "sequelize";
import { extractAuth } from "../middleware/auth.js";
import { readJsonBody } from "../src/request.js";
import * as service from "../src/erasure/erasureService.js";
import {
  confirmErasureHandler, createErasureRequestHandler,
  getErasureCertificateHandler, getErasureStatusHandler,
} from "./erasure.js";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/db.js", () => ({ sequelize: { query } }));
vi.mock("../middleware/auth.js", () => ({ extractAuth: vi.fn() }));
vi.mock("../middleware/requestId.js", () => ({ getRequestContext: () => ({ requestId: "trace-1" }) }));
vi.mock("../src/request.js", () => ({
  readJsonBody: vi.fn(), InvalidJsonError: class extends Error {}, BodyTooLargeError: class extends Error {},
}));
vi.mock("../src/erasure/erasureService.js", () => ({
  createErasureRequest: vi.fn(), executeAccountErasure: vi.fn(), generateErasureCertificate: vi.fn(),
  getErasureRequestStatus: vi.fn(), getErasureCertificate: vi.fn(),
}));
vi.mock("@delegolabs/utils", () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn() }), generateId: () => "trace-1",
  json: (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  },
}));

const req = { headers: {} } as IncomingMessage;
const wallet = `G${"A".repeat(55)}`;
const row = {
  id: "request-1", user_id: "user-1", wallet_address: wallet,
  status: "pending", confirmation_hash: "secret", confirmation_method: "two_factor",
};
function response() {
  const writeHead = vi.fn();
  const end = vi.fn();
  return { res: { writeHead, end } as unknown as ServerResponse, writeHead, end };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(extractAuth).mockReturnValue({ userId: "user-1", token: "token" });
  vi.mocked(readJsonBody).mockResolvedValue({ requestId: "request-1", confirmationHash: "secret" });
});

it("loads the corrected database import and rejects missing confirmation rows", async () => {
  query.mockResolvedValueOnce([]);
  const { res, writeHead, end } = response();
  await confirmErasureHandler(req, res);
  expect(writeHead).toHaveBeenCalledWith(403, expect.any(Object));
  expect(JSON.parse(end.mock.calls[0][0]).error.message).toContain("not found");
  expect(query).toHaveBeenCalledWith(expect.stringContaining("WHERE id = $1 AND user_id = $2"), {
    bind: ["request-1", "user-1"], type: QueryTypes.SELECT,
  });
  expect(service.executeAccountErasure).not.toHaveBeenCalled();
});

it.each([
  { ...row, status: "completed" },
  { ...row, confirmation_hash: "different" },
])("rejects an invalid confirmation without executing erasure", async (result) => {
  query.mockResolvedValueOnce([result]);
  const { res, writeHead } = response();
  await confirmErasureHandler(req, res);
  expect(writeHead).toHaveBeenCalledWith(403, expect.any(Object));
  expect(query).toHaveBeenCalledTimes(1);
  expect(service.executeAccountErasure).not.toHaveBeenCalled();
});

it("binds confirmation updates and returns the successful report", async () => {
  query.mockResolvedValueOnce([row]).mockResolvedValue([]);
  const report = {
    userId: "user-1", walletAddress: wallet, anonymizedPaymentRecords: 2,
    purgedChatMessages: 0, purgedPreferences: 1, completedAt: "2026-01-01T00:00:00Z",
  };
  vi.mocked(service.executeAccountErasure).mockResolvedValue(report);
  vi.mocked(service.generateErasureCertificate).mockResolvedValue({
    id: "certificate-1", userId: "user-1", walletAddress: wallet,
    certificateHash: "certificate-hash", issuedAt: report.completedAt,
  });
  const { res, writeHead, end } = response();
  await confirmErasureHandler(req, res);
  expect(writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  expect(JSON.parse(end.mock.calls[0][0]).data.report).toEqual(report);
  expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining("'processing'"), {
    bind: ["request-1"], type: QueryTypes.UPDATE,
  });
  expect(query).toHaveBeenNthCalledWith(3, expect.stringContaining("'completed'"), {
    bind: [2, 0, 1, "request-1"], type: QueryTypes.UPDATE,
  });
});

it("requires authentication before querying", async () => {
  vi.mocked(extractAuth).mockReturnValue({ userId: null, token: null });
  const { res, writeHead } = response();
  await confirmErasureHandler(req, res);
  expect(writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  expect(query).not.toHaveBeenCalled();
});

it("returns the confirmation error envelope on database failure", async () => {
  query.mockRejectedValueOnce(new Error("database unavailable"));
  const { res, writeHead, end } = response();
  await confirmErasureHandler(req, res);
  expect(writeHead).toHaveBeenCalledWith(500, expect.any(Object));
  expect(JSON.parse(end.mock.calls[0][0]).error.code).toBe("ERASURE_CONFIRMATION_FAILED");
});

it("maps a created request to the accepted response", async () => {
  vi.mocked(readJsonBody).mockResolvedValue({ walletAddress: wallet, confirmationHash: "secret", confirmationMethod: "two_factor" });
  vi.mocked(service.createErasureRequest).mockResolvedValue({
    id: "request-1", userId: "user-1", walletAddress: wallet, confirmationHash: "secret",
    confirmationMethod: "two_factor", status: "pending", createdAt: "2026-01-01T00:00:00Z",
  });
  const { res, writeHead, end } = response();
  await createErasureRequestHandler(req, res);
  expect(writeHead).toHaveBeenCalledWith(202, expect.any(Object));
  expect(JSON.parse(end.mock.calls[0][0]).data.erasureRequest.id).toBe("request-1");
});

it("returns 404 for absent status and certificate records", async () => {
  const status = response();
  await getErasureStatusHandler(req, status.res, { requestId: "missing" });
  expect(status.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
  const certificate = response();
  await getErasureCertificateHandler(req, certificate.res, { certificateHash: "missing" });
  expect(certificate.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
});

it("serializes a pending status with nullable completion and certificate fields", async () => {
  vi.mocked(service.getErasureRequestStatus).mockResolvedValue({
    ...row, anonymized_payment_records: 0, purged_chat_messages: 0, purged_preferences: 0,
    completed_at: null, failed_at: null, error_message: null,
    initiated_at: new Date("2026-01-01T00:00:00Z"), certificate_hash: null,
  });
  const { res, writeHead, end } = response();
  await getErasureStatusHandler(req, res, { requestId: "request-1" });
  expect(writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  expect(JSON.parse(end.mock.calls[0][0]).data.erasureRequest).toMatchObject({
    completedAt: null, failedAt: null, errorMessage: null, certificateHash: null,
    initiatedAt: "2026-01-01T00:00:00.000Z",
  });
});
