import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { escrowCoordinator, InsufficientEscrowBalanceError } from "../escrowCoordinator/index.js";
import { executePartialRefund, InvalidPartialRefundAmountError } from "./partialRefund.js";
import type { PartialRefundRequest } from "./types.js";

vi.mock("../escrowCoordinator/index.js", async () => {
  const actual = await vi.importActual<typeof import("../escrowCoordinator/index.js")>(
    "../escrowCoordinator/index.js"
  );
  return {
    ...actual,
    escrowCoordinator: {
      getEscrowStatus: vi.fn(),
      getRemainingBalance: vi.fn(),
      releaseEscrow: vi.fn(),
      refundEscrow: vi.fn(),
      disputeEscrow: vi.fn(),
      partialRefundEscrow: vi.fn(),
      partialReleaseEscrow: vi.fn(),
      fundEscrow: vi.fn(),
    },
  };
});

function request(overrides: Partial<PartialRefundRequest> = {}): PartialRefundRequest {
  return {
    escrowId: "42",
    amount: "300",
    reason: "Item arrived damaged",
    requestedBy: "GBUYER",
    ...overrides,
  };
}

function balance(overrides: Partial<Awaited<ReturnType<typeof escrowCoordinator.getRemainingBalance>>> = {}) {
  return {
    escrowId: "42",
    orderId: "order-1",
    buyerAddress: "GBUYER",
    sellerAddress: "GSELLER",
    totalAmount: "1000",
    releasedAmount: "0",
    refundedAmount: "0",
    remainingAmount: "1000",
    ...overrides,
  };
}

describe("executePartialRefund", () => {
  beforeEach(() => {
    process.env.ESCROW_CONTRACT_ID = "CCONTRACTID000000000000000000000000000000000000000000000000";
    vi.mocked(escrowCoordinator.getRemainingBalance).mockReset();
    vi.mocked(escrowCoordinator.partialRefundEscrow).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ESCROW_CONTRACT_ID;
  });

  it("executes a valid partial refund within the remaining balance", async () => {
    vi.mocked(escrowCoordinator.getRemainingBalance).mockResolvedValue(balance());
    vi.mocked(escrowCoordinator.partialRefundEscrow).mockResolvedValue({
      txHash: "tx-partial-refund",
      ledger: 5,
      status: "partial_refunded",
      buyerAddress: "GBUYER",
      refundedAmount: "300",
      remainingAmount: "700",
    });

    const outcome = await executePartialRefund(request());

    expect(outcome.success).toBe(true);
    expect(outcome.transactionHash).toBe("tx-partial-refund");
    expect(outcome.refundedAmount).toBe("300");
    expect(outcome.remainingAmount).toBe("700");
    expect(escrowCoordinator.partialRefundEscrow).toHaveBeenCalledWith({
      escrowId: "42",
      escrowContractId: "CCONTRACTID000000000000000000000000000000000000000000000000",
      callerAddress: "GBUYER",
      amountStroops: "300",
      reason: "Item arrived damaged",
    });
  });

  it("rejects a non-numeric amount before touching the balance or the chain", async () => {
    await expect(executePartialRefund(request({ amount: "not-a-number" }))).rejects.toThrow(
      InvalidPartialRefundAmountError
    );
    expect(escrowCoordinator.getRemainingBalance).not.toHaveBeenCalled();
  });

  it("rejects a zero amount", async () => {
    await expect(executePartialRefund(request({ amount: "0" }))).rejects.toThrow(InvalidPartialRefundAmountError);
  });

  it("propagates InsufficientEscrowBalanceError when the amount exceeds the remaining balance", async () => {
    vi.mocked(escrowCoordinator.getRemainingBalance).mockResolvedValue(balance({ remainingAmount: "100" }));
    vi.mocked(escrowCoordinator.partialRefundEscrow).mockRejectedValue(
      new InsufficientEscrowBalanceError("42", "100", "300")
    );

    await expect(executePartialRefund(request({ amount: "300" }))).rejects.toThrow(InsufficientEscrowBalanceError);
  });

  it("reports failure when the on-chain call fails without throwing", async () => {
    vi.mocked(escrowCoordinator.getRemainingBalance).mockResolvedValue(balance());
    vi.mocked(escrowCoordinator.partialRefundEscrow).mockResolvedValue({
      txHash: "tx-failed",
      ledger: 0,
      status: "failed",
      buyerAddress: "GBUYER",
      refundedAmount: "0",
      remainingAmount: "1000",
    });

    const outcome = await executePartialRefund(request());

    expect(outcome.success).toBe(false);
    expect(outcome.error).toBeDefined();
    expect(outcome.transactionHash).toBeUndefined();
  });
});
