/**
 * Unit tests for #35 — order-level escrow compensation: settleOrder (release)
 * and refundOrder, both idempotent per orderId via payment_records.status.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@delegolabs/utils", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../escrow/index.js", () => ({
  escrowService: {
    release: vi.fn(),
    initialize: vi.fn(),
    deposit: vi.fn(),
    refund: vi.fn(),
  },
}));

vi.mock("../events/index.js", () => ({
  publishPaymentEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../escrow/wallet-client.js", () => ({
  getTransactionFeeEstimate: vi.fn().mockResolvedValue({
    source: "horizon",
    baseFeeStroops: 100,
    recommendedFeeStroops: 150,
    percentile: "p95",
    fetchedAt: "2026-07-24T05:00:00.000Z",
  }),
}));

vi.mock("../src/escrowCoordinator/paymentRecordStore.js", () => ({
  findPaymentRecordByOrderId: vi.fn(),
  updatePaymentRecord: vi.fn(),
}));

import { settleOrder, refundOrder } from "./index.js";
import { escrowService } from "../escrow/index.js";
import { publishPaymentEvent } from "../events/index.js";
import {
  findPaymentRecordByOrderId,
  updatePaymentRecord,
} from "../src/escrowCoordinator/paymentRecordStore.js";
import type { PaymentRecord } from "../src/escrowCoordinator/types.js";

function makeRecord(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: "rec-1",
    orderId: "order-1",
    escrowId: "42",
    escrowContractId: "CCONTRACT",
    buyerAddress: "GBUYER",
    sellerAddress: "GSELLER",
    tokenContractId: "CTOKEN",
    amountStroops: "1000",
    status: "funded",
    fundTxHash: "fundtx",
    releaseTxHash: null,
    refundTxHash: null,
    disputeTxHash: null,
    failureReason: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("settleOrder (#35)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updatePaymentRecord).mockResolvedValue(makeRecord());
    process.env = { ...originalEnv, SETTLEMENT_SOURCE_ADDRESS: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYSFTXF4WZN2HNCTGI3" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws when orderId is empty", async () => {
    await expect(settleOrder("")).rejects.toThrow("orderId is required");
  });

  it("returns no_escrow when no payment record exists for the order", async () => {
    vi.mocked(findPaymentRecordByOrderId).mockResolvedValue(null);

    const result = await settleOrder("order-missing");

    expect(result).toEqual({
      orderId: "order-missing",
      escrowId: null,
      status: "no_escrow",
      txHash: null,
      alreadySettled: false,
      reason: "No funded escrow found for order",
    });
    expect(escrowService.release).not.toHaveBeenCalled();
  });

  it("is idempotent: returns the recorded outcome without calling the contract when already released", async () => {
    vi.mocked(findPaymentRecordByOrderId).mockResolvedValue(
      makeRecord({ status: "released", releaseTxHash: "release-tx-1" })
    );

    const result = await settleOrder("order-1");

    expect(result).toEqual({
      orderId: "order-1",
      escrowId: "42",
      status: "released",
      txHash: "release-tx-1",
      alreadySettled: true,
    });
    expect(escrowService.release).not.toHaveBeenCalled();
    expect(updatePaymentRecord).not.toHaveBeenCalled();
  });

  it("refuses to release an escrow that was already refunded (would double-pay from empty escrow)", async () => {
    vi.mocked(findPaymentRecordByOrderId).mockResolvedValue(makeRecord({ status: "refunded" }));

    const result = await settleOrder("order-1");

    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/already refunded/);
    expect(escrowService.release).not.toHaveBeenCalled();
  });

  it("releases escrow, updates the record, and publishes an event on success", async () => {
    vi.mocked(findPaymentRecordByOrderId).mockResolvedValue(makeRecord());
    vi.mocked(escrowService.release).mockResolvedValue({
      txHash: "release-tx-2",
      ledger: 100,
      success: true,
    });

    const result = await settleOrder("order-1");

    expect(escrowService.release).toHaveBeenCalledWith({
      sourceAddress: process.env.SETTLEMENT_SOURCE_ADDRESS,
      escrowId: "42",
    });
    expect(updatePaymentRecord).toHaveBeenCalledWith("rec-1", {
      status: "released",
      releaseTxHash: "release-tx-2",
      failureReason: null,
    });
    expect(publishPaymentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "escrow_released", orderId: "order-1" })
    );
    expect(result).toEqual({
      orderId: "order-1",
      escrowId: "42",
      status: "released",
      txHash: "release-tx-2",
      alreadySettled: false,
    });
  });

  it("marks the record failed when the release transaction fails on-chain", async () => {
    vi.mocked(findPaymentRecordByOrderId).mockResolvedValue(makeRecord());
    vi.mocked(escrowService.release).mockResolvedValue({
      txHash: "release-tx-3",
      ledger: 100,
      success: false,
    });

    const result = await settleOrder("order-1");

    expect(result.status).toBe("failed");
    expect(updatePaymentRecord).toHaveBeenCalledWith("rec-1", {
      status: "failed",
      failureReason: "Release transaction failed on-chain",
    });
    expect(publishPaymentEvent).not.toHaveBeenCalled();
  });

  it("marks the record failed and returns failed status when the contract call throws", async () => {
    vi.mocked(findPaymentRecordByOrderId).mockResolvedValue(makeRecord());
    vi.mocked(escrowService.release).mockRejectedValue(new Error("Soroban RPC timeout"));

    const result = await settleOrder("order-1");

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("Soroban RPC timeout");
    expect(updatePaymentRecord).toHaveBeenCalledWith("rec-1", {
      status: "failed",
      failureReason: "Soroban RPC timeout",
    });
  });

  it("throws when SETTLEMENT_SOURCE_ADDRESS is not configured", async () => {
    delete process.env.SETTLEMENT_SOURCE_ADDRESS;
    vi.mocked(findPaymentRecordByOrderId).mockResolvedValue(makeRecord());

    await expect(settleOrder("order-1")).rejects.toThrow(
      "SETTLEMENT_SOURCE_ADDRESS environment variable is not configured"
    );
    expect(escrowService.release).not.toHaveBeenCalled();
  });
});

describe("refundOrder (#35)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updatePaymentRecord).mockResolvedValue(makeRecord());
    process.env = { ...originalEnv, SETTLEMENT_SOURCE_ADDRESS: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYSFTXF4WZN2HNCTGI3" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws when orderId is empty", async () => {
    await expect(refundOrder("")).rejects.toThrow("orderId is required");
  });

  it("returns no_escrow when no payment record exists for the order", async () => {
    vi.mocked(findPaymentRecordByOrderId).mockResolvedValue(null);

    const result = await refundOrder("order-missing");

    expect(result.status).toBe("no_escrow");
    expect(escrowService.refund).not.toHaveBeenCalled();
  });

  it("is idempotent: returns the recorded outcome without calling the contract when already refunded", async () => {
    vi.mocked(findPaymentRecordByOrderId).mockResolvedValue(
      makeRecord({ status: "refunded", refundTxHash: "refund-tx-1" })
    );

    const result = await refundOrder("order-1");

    expect(result).toEqual({
      orderId: "order-1",
      escrowId: "42",
      status: "refunded",
      txHash: "refund-tx-1",
      alreadySettled: true,
    });
    expect(escrowService.refund).not.toHaveBeenCalled();
  });

  it("refuses to refund an escrow that was already released", async () => {
    vi.mocked(findPaymentRecordByOrderId).mockResolvedValue(makeRecord({ status: "released" }));

    const result = await refundOrder("order-1");

    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/already released/);
    expect(escrowService.refund).not.toHaveBeenCalled();
  });

  it("refunds escrow with the given reason code, updates the record, and publishes an event", async () => {
    vi.mocked(findPaymentRecordByOrderId).mockResolvedValue(makeRecord());
    vi.mocked(escrowService.refund).mockResolvedValue({
      txHash: "refund-tx-2",
      ledger: 101,
      success: true,
    });

    const result = await refundOrder("order-1", "merchant_cancelled");

    expect(escrowService.refund).toHaveBeenCalledWith({
      sourceAddress: process.env.SETTLEMENT_SOURCE_ADDRESS,
      escrowId: "42",
      refundReasonCode: "merchant_cancelled",
    });
    expect(updatePaymentRecord).toHaveBeenCalledWith("rec-1", {
      status: "refunded",
      refundTxHash: "refund-tx-2",
      failureReason: null,
    });
    expect(publishPaymentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "escrow_refunded",
        orderId: "order-1",
        payload: expect.objectContaining({ reasonCode: "merchant_cancelled" }),
      })
    );
    expect(result.status).toBe("refunded");
  });

  it("defaults to system_error reason code when none is given", async () => {
    vi.mocked(findPaymentRecordByOrderId).mockResolvedValue(makeRecord());
    vi.mocked(escrowService.refund).mockResolvedValue({
      txHash: "refund-tx-3",
      ledger: 101,
      success: true,
    });

    await refundOrder("order-1");

    expect(escrowService.refund).toHaveBeenCalledWith(
      expect.objectContaining({ refundReasonCode: "system_error" })
    );
  });

  it("marks the record failed when the refund transaction fails on-chain", async () => {
    vi.mocked(findPaymentRecordByOrderId).mockResolvedValue(makeRecord());
    vi.mocked(escrowService.refund).mockResolvedValue({
      txHash: "refund-tx-4",
      ledger: 101,
      success: false,
    });

    const result = await refundOrder("order-1");

    expect(result.status).toBe("failed");
    expect(updatePaymentRecord).toHaveBeenCalledWith("rec-1", {
      status: "failed",
      failureReason: "Refund transaction failed on-chain",
    });
  });

  it("marks the record failed and returns failed status when the contract call throws", async () => {
    vi.mocked(findPaymentRecordByOrderId).mockResolvedValue(makeRecord());
    vi.mocked(escrowService.refund).mockRejectedValue(new Error("Soroban RPC timeout"));

    const result = await refundOrder("order-1");

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("Soroban RPC timeout");
  });

  it("throws when SETTLEMENT_SOURCE_ADDRESS is not configured", async () => {
    delete process.env.SETTLEMENT_SOURCE_ADDRESS;
    vi.mocked(findPaymentRecordByOrderId).mockResolvedValue(makeRecord());

    await expect(refundOrder("order-1")).rejects.toThrow(
      "SETTLEMENT_SOURCE_ADDRESS environment variable is not configured"
    );
    expect(escrowService.refund).not.toHaveBeenCalled();
  });
});
