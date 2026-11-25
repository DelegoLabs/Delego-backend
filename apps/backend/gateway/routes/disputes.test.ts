import { describe, it, expect, beforeEach, vi } from "vitest";
import { validateDisputeResponseRequest, submitDisputeResponseHandler, extractAddressFromAuth } from "./disputes.js";
import type { SubmitDisputeResponseDTO } from "./disputes.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("@delegolabs/payments", () => ({
  submitMerchantResponse: vi.fn(),
  escrowCoordinator: {
    getRemainingBalance: vi.fn(),
  },
}));

vi.mock("../src/request.js", () => ({
  readJsonBody: vi.fn(),
}));

vi.mock("@delegolabs/utils", async () => {
  const actual = await vi.importActual<typeof import("@delegolabs/utils")>("@delegolabs/utils");
  return {
    ...actual,
    json: vi.fn(),
    createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
    route: vi.fn((method, path, handler) => ({ method, path, handler })),
  };
});

import { submitMerchantResponse, escrowCoordinator } from "@delegolabs/payments";
import { readJsonBody } from "../src/request.js";
import { json } from "@delegolabs/utils";

const MERCHANT_ADDRESS = "GMERCHANT123456789012345678901234567890123456789012345";
const BUYER_ADDRESS   = "GBUYER123456789012345678901234567890123456789012345678";
const OTHER_ADDRESS   = "GOTHER1234567890123456789012345678901234567890123456789";
const ESCROW_ID       = "escrow-abc-001";
const DISPUTE_ID      = "dispute-xyz-001";

function makeReq(overrides: {
  authorization?: string;
  body?: unknown;
  params?: Record<string, string>;
}) {
  return {
    headers: { authorization: overrides.authorization ?? `Bearer ${MERCHANT_ADDRESS}` },
    _body: overrides.body,
    _params: overrides.params ?? { disputeId: DISPUTE_ID },
  };
}

function makeMockReqRes(body: unknown, authHeader?: string, disputeIdParam = DISPUTE_ID) {
  const req = {
    headers: { authorization: authHeader ?? `Bearer ${MERCHANT_ADDRESS}` },
  } as any;

  const res = {} as any;
  const params = { disputeId: disputeIdParam };

  vi.mocked(readJsonBody).mockResolvedValue(body as any);

  return { req, res, params };
}

// ── validateDisputeResponseRequest ────────────────────────────────────────

describe("validateDisputeResponseRequest", () => {
  it("accepts a fully valid request", () => {
    const req: SubmitDisputeResponseDTO = {
      disputeId: DISPUTE_ID,
      escrowId: ESCROW_ID,
      responseStatement: "Goods shipped and delivered",
      evidenceAttachmentUrls: ["https://example.com/proof.pdf"],
      partialRefundAmountStroops: "5000000",
    };
    expect(validateDisputeResponseRequest(req).valid).toBe(true);
  });

  it("accepts request without optional fields", () => {
    expect(
      validateDisputeResponseRequest({ disputeId: DISPUTE_ID, escrowId: ESCROW_ID, responseStatement: "OK" }).valid,
    ).toBe(true);
  });

  it("rejects missing disputeId", () => {
    const result = validateDisputeResponseRequest({
      disputeId: "",
      escrowId: ESCROW_ID,
      responseStatement: "OK",
    });
    expect(result.valid).toBe(false);
    expect((result as any).error).toBe("disputeId is required");
  });

  it("rejects missing escrowId", () => {
    const result = validateDisputeResponseRequest({
      disputeId: DISPUTE_ID,
      escrowId: "",
      responseStatement: "OK",
    });
    expect(result.valid).toBe(false);
    expect((result as any).error).toBe("escrowId is required");
  });

  it("rejects missing responseStatement", () => {
    const result = validateDisputeResponseRequest({
      disputeId: DISPUTE_ID,
      escrowId: ESCROW_ID,
      responseStatement: "",
    });
    expect(result.valid).toBe(false);
    expect((result as any).error).toBe("responseStatement is required");
  });

  it("rejects non-numeric partialRefundAmountStroops", () => {
    const result = validateDisputeResponseRequest({
      disputeId: DISPUTE_ID,
      escrowId: ESCROW_ID,
      responseStatement: "OK",
      partialRefundAmountStroops: "abc",
    });
    expect(result.valid).toBe(false);
    expect((result as any).error).toBe("partialRefundAmountStroops must be a positive integer string");
  });

  it("rejects negative partialRefundAmountStroops", () => {
    const result = validateDisputeResponseRequest({
      disputeId: DISPUTE_ID,
      escrowId: ESCROW_ID,
      responseStatement: "OK",
      partialRefundAmountStroops: "-1000",
    });
    expect(result.valid).toBe(false);
    expect((result as any).error).toBe("partialRefundAmountStroops must be a positive integer string");
  });

  it("rejects non-array evidenceAttachmentUrls", () => {
    const result = validateDisputeResponseRequest({
      disputeId: DISPUTE_ID,
      escrowId: ESCROW_ID,
      responseStatement: "OK",
      evidenceAttachmentUrls: "not-an-array" as any,
    });
    expect(result.valid).toBe(false);
    expect((result as any).error).toBe("evidenceAttachmentUrls must be an array");
  });

  it("rejects non-string items in evidenceAttachmentUrls", () => {
    const result = validateDisputeResponseRequest({
      disputeId: DISPUTE_ID,
      escrowId: ESCROW_ID,
      responseStatement: "OK",
      evidenceAttachmentUrls: [123] as any,
    });
    expect(result.valid).toBe(false);
    expect((result as any).error).toBe("evidenceAttachmentUrls must contain only strings");
  });
});

// ── extractAddressFromAuth ─────────────────────────────────────────────────

describe("extractAddressFromAuth", () => {
  it("extracts address from valid Bearer token", () => {
    expect(extractAddressFromAuth(`Bearer ${MERCHANT_ADDRESS}`)).toBe(MERCHANT_ADDRESS);
  });

  it("returns null for missing header", () => {
    expect(extractAddressFromAuth(undefined)).toBeNull();
  });

  it("returns null for non-Bearer scheme", () => {
    expect(extractAddressFromAuth(`Basic ${MERCHANT_ADDRESS}`)).toBeNull();
  });

  it("returns null for empty token", () => {
    expect(extractAddressFromAuth("Bearer ")).toBeNull();
  });
});

// ── submitDisputeResponseHandler — merchant check ─────────────────────────

describe("submitDisputeResponseHandler — merchant authorization", () => {
  const validBody: SubmitDisputeResponseDTO = {
    disputeId: DISPUTE_ID,
    escrowId: ESCROW_ID,
    responseStatement: "We delivered the goods",
  };

  const mockDispute = {
    id: DISPUTE_ID,
    escrowId: ESCROW_ID,
    status: "merchant_responded",
    updatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 200 when callerAddress matches escrow sellerAddress (authorized merchant)", async () => {
    const { req, res, params } = makeMockReqRes(validBody, `Bearer ${MERCHANT_ADDRESS}`);

    vi.mocked(escrowCoordinator.getRemainingBalance).mockResolvedValue({
      sellerAddress: MERCHANT_ADDRESS,
      buyerAddress: BUYER_ADDRESS,
      remainingAmount: "10000000",
      orderId: "order-001",
    } as any);

    vi.mocked(submitMerchantResponse).mockResolvedValue(mockDispute as any);

    await submitDisputeResponseHandler(req, res, params);

    expect(json).toHaveBeenCalledWith(res, 200, expect.objectContaining({ data: expect.objectContaining({ disputeId: DISPUTE_ID }) }));
    expect(submitMerchantResponse).toHaveBeenCalledWith(
      DISPUTE_ID,
      MERCHANT_ADDRESS,
      "We delivered the goods",
      undefined,
      undefined,
    );
  });

  it("returns 403 when callerAddress does NOT match escrow sellerAddress (unauthorized caller)", async () => {
    const { req, res, params } = makeMockReqRes(validBody, `Bearer ${OTHER_ADDRESS}`);

    vi.mocked(escrowCoordinator.getRemainingBalance).mockResolvedValue({
      sellerAddress: MERCHANT_ADDRESS,
      buyerAddress: BUYER_ADDRESS,
      remainingAmount: "10000000",
      orderId: "order-001",
    } as any);

    await submitDisputeResponseHandler(req, res, params);

    expect(json).toHaveBeenCalledWith(res, 403, expect.objectContaining({
      error: expect.objectContaining({ code: "FORBIDDEN" }),
    }));
    expect(submitMerchantResponse).not.toHaveBeenCalled();
  });

  it("returns 403 when buyer tries to submit a merchant response", async () => {
    const { req, res, params } = makeMockReqRes(validBody, `Bearer ${BUYER_ADDRESS}`);

    vi.mocked(escrowCoordinator.getRemainingBalance).mockResolvedValue({
      sellerAddress: MERCHANT_ADDRESS,
      buyerAddress: BUYER_ADDRESS,
      remainingAmount: "10000000",
      orderId: "order-001",
    } as any);

    await submitDisputeResponseHandler(req, res, params);

    expect(json).toHaveBeenCalledWith(res, 403, expect.objectContaining({
      error: expect.objectContaining({ code: "FORBIDDEN" }),
    }));
    expect(submitMerchantResponse).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header is missing", async () => {
    const { req, res, params } = makeMockReqRes(validBody, undefined);
    // Override to remove auth header entirely
    req.headers = {};

    await submitDisputeResponseHandler(req, res, params);

    expect(json).toHaveBeenCalledWith(res, 401, expect.objectContaining({
      error: expect.objectContaining({ code: "AUTH_REQUIRED" }),
    }));
  });

  it("returns 404 when escrow cannot be resolved", async () => {
    const { req, res, params } = makeMockReqRes(validBody, `Bearer ${MERCHANT_ADDRESS}`);

    vi.mocked(escrowCoordinator.getRemainingBalance).mockRejectedValue(new Error("Escrow not found"));

    await submitDisputeResponseHandler(req, res, params);

    expect(json).toHaveBeenCalledWith(res, 404, expect.objectContaining({
      error: expect.objectContaining({ code: "ESCROW_NOT_FOUND" }),
    }));
    expect(submitMerchantResponse).not.toHaveBeenCalled();
  });

  it("returns 409 when dispute is in wrong state", async () => {
    const { req, res, params } = makeMockReqRes(validBody, `Bearer ${MERCHANT_ADDRESS}`);

    vi.mocked(escrowCoordinator.getRemainingBalance).mockResolvedValue({
      sellerAddress: MERCHANT_ADDRESS,
      buyerAddress: BUYER_ADDRESS,
      remainingAmount: "10000000",
      orderId: "order-001",
    } as any);

    const stateErr = new Error('Cannot transition dispute from "open" to "merchant_responded"');
    stateErr.name = "InvalidStateTransitionError";
    vi.mocked(submitMerchantResponse).mockRejectedValue(stateErr);

    await submitDisputeResponseHandler(req, res, params);

    expect(json).toHaveBeenCalledWith(res, 409, expect.objectContaining({
      error: expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }),
    }));
  });

  it("returns 400 when escrowId is missing from body", async () => {
    const bodyWithoutEscrow = { disputeId: DISPUTE_ID, responseStatement: "OK" } as any;
    const { req, res, params } = makeMockReqRes(bodyWithoutEscrow, `Bearer ${MERCHANT_ADDRESS}`);

    await submitDisputeResponseHandler(req, res, params);

    expect(json).toHaveBeenCalledWith(res, 400, expect.objectContaining({
      error: expect.objectContaining({ code: "VALIDATION_ERROR" }),
    }));
  });
});
