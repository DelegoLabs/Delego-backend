import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { escrowCoordinator } from "../escrowCoordinator/index.js";
import { resetAuditLogStore } from "./auditLog.js";
import { resetDisputeStore, getDisputeStore } from "./disputeStore.js";
import {
  assignMediator,
  executeDecision,
  openDispute,
  submitEvidence,
  submitMediationDecision,
} from "./mediation.js";
import { getDisputeReputation, resetReputationStore } from "./reputationStore.js";
import { DisputeAlreadyResolvedError, DisputeNotFoundError, InvalidResolutionAmountsError, InvalidStateTransitionError } from "./types.js";

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

describe("dispute mediation workflow", () => {
  beforeEach(() => {
    process.env.ESCROW_CONTRACT_ID = "CCONTRACTID000000000000000000000000000000000000000000000000";
    resetDisputeStore();
    resetAuditLogStore();
    resetReputationStore();
    vi.mocked(escrowCoordinator.getRemainingBalance).mockReset().mockResolvedValue(balance());
    vi.mocked(escrowCoordinator.disputeEscrow).mockReset().mockResolvedValue({
      txHash: "tx-dispute",
      ledger: 1,
      status: "disputed",
      disputedBy: "GBUYER",
    });
    vi.mocked(escrowCoordinator.partialRefundEscrow).mockReset();
    vi.mocked(escrowCoordinator.partialReleaseEscrow).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ESCROW_CONTRACT_ID;
  });

  describe("openDispute", () => {
    it("creates an open dispute with a 14-day SLA deadline by default", async () => {
      const before = Date.now();
      const dispute = await openDispute({ escrowId: "42", initiatedBy: "GBUYER", reason: "Item never arrived" });
      const after = Date.now();

      expect(dispute.status).toBe("open");
      expect(dispute.escrowId).toBe("42");
      expect(dispute.evidence).toEqual([]);

      const deadline = new Date(dispute.slaDeadline).getTime();
      const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
      expect(deadline).toBeGreaterThanOrEqual(before + fourteenDaysMs - 1000);
      expect(deadline).toBeLessThanOrEqual(after + fourteenDaysMs + 1000);
    });

    it("flags the escrow disputed on-chain and records reputation for both parties", async () => {
      const dispute = await openDispute({ escrowId: "42", initiatedBy: "GBUYER", reason: "Not as described" });

      expect(escrowCoordinator.disputeEscrow).toHaveBeenCalledWith({
        escrowId: "42",
        escrowContractId: "CCONTRACTID000000000000000000000000000000000000000000000000",
        callerAddress: "GBUYER",
      });

      const buyerRep = await getDisputeReputation("GBUYER");
      const sellerRep = await getDisputeReputation("GSELLER");
      expect(buyerRep?.disputesInitiated).toBe(1);
      expect(sellerRep?.disputesInvolved).toBe(1);
      expect(dispute.initiatedBy).toBe("GBUYER");
    });

    it("still creates the dispute record when the on-chain dispute flag fails", async () => {
      vi.mocked(escrowCoordinator.disputeEscrow).mockRejectedValue(new Error("RPC unavailable"));

      const dispute = await openDispute({ escrowId: "42", initiatedBy: "GBUYER", reason: "Not delivered" });

      expect(dispute.status).toBe("open");
      const fetched = await getDisputeStore().findById(dispute.id);
      expect(fetched).not.toBeNull();
    });

    it("honors a custom slaDays override", async () => {
      const dispute = await openDispute({ escrowId: "42", initiatedBy: "GBUYER", reason: "x", slaDays: 3 });
      const deadline = new Date(dispute.slaDeadline).getTime();
      const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
      expect(deadline - Date.now()).toBeLessThanOrEqual(threeDaysMs + 1000);
      expect(deadline - Date.now()).toBeGreaterThan(threeDaysMs - 60_000);
    });
  });

  describe("submitEvidence", () => {
    it("auto-advances an open dispute into evidence_collection on first submission", async () => {
      const dispute = await openDispute({ escrowId: "42", initiatedBy: "GBUYER", reason: "x" });

      const updated = await submitEvidence(dispute.id, {
        party: "GBUYER",
        description: "Photo of damaged item",
        files: ["ipfs://abc123"],
      });

      expect(updated.status).toBe("evidence_collection");
      expect(updated.evidence).toHaveLength(1);
      expect(updated.evidence[0].party).toBe("GBUYER");
      expect(updated.evidence[0].submittedAt).toBeDefined();
    });

    it("accepts further evidence while already in evidence_collection", async () => {
      const dispute = await openDispute({ escrowId: "42", initiatedBy: "GBUYER", reason: "x" });
      await submitEvidence(dispute.id, { party: "GBUYER", description: "first", files: ["a"] });
      const updated = await submitEvidence(dispute.id, { party: "GSELLER", description: "rebuttal", files: ["b"] });

      expect(updated.status).toBe("evidence_collection");
      expect(updated.evidence).toHaveLength(2);
    });

    it("rejects evidence once the dispute has moved into negotiation", async () => {
      const dispute = await openDispute({ escrowId: "42", initiatedBy: "GBUYER", reason: "x" });
      await assignMediator(dispute.id, "GMEDIATOR");

      await expect(
        submitEvidence(dispute.id, { party: "GBUYER", description: "too late", files: ["c"] })
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it("throws DisputeNotFoundError for an unknown dispute", async () => {
      await expect(
        submitEvidence("does-not-exist", { party: "GBUYER", description: "x", files: ["a"] })
      ).rejects.toThrow(DisputeNotFoundError);
    });
  });

  describe("assignMediator", () => {
    it("fast-tracks an 'open' dispute straight into negotiation", async () => {
      const dispute = await openDispute({ escrowId: "42", initiatedBy: "GBUYER", reason: "x" });

      const updated = await assignMediator(dispute.id, "GMEDIATOR", "admin-1");

      expect(updated.status).toBe("negotiation");
      expect(updated.mediator).toBe("GMEDIATOR");
    });

    it("rejects reassignment once the dispute is decided", async () => {
      vi.mocked(escrowCoordinator.partialRefundEscrow).mockResolvedValue({
        txHash: "tx-r",
        ledger: 1,
        status: "partial_refunded",
        buyerAddress: "GBUYER",
        refundedAmount: "1000",
        remainingAmount: "0",
      });

      const dispute = await openDispute({ escrowId: "42", initiatedBy: "GBUYER", reason: "x" });
      await assignMediator(dispute.id, "GMEDIATOR");
      await submitMediationDecision({
        disputeId: dispute.id,
        decision: "full_refund",
        buyerAmount: "1000",
        sellerAmount: "0",
        reasoning: "Item never arrived",
        mediator: "GMEDIATOR",
      });

      await expect(assignMediator(dispute.id, "GOTHER")).rejects.toThrow(InvalidStateTransitionError);
    });
  });

  describe("submitMediationDecision / executeDecision", () => {
    async function disputeInNegotiation(mediator = "GMEDIATOR") {
      const dispute = await openDispute({ escrowId: "42", initiatedBy: "GBUYER", reason: "x" });
      return assignMediator(dispute.id, mediator);
    }

    it("rejects a decision before the dispute reaches negotiation", async () => {
      const dispute = await openDispute({ escrowId: "42", initiatedBy: "GBUYER", reason: "x" });

      await expect(
        submitMediationDecision({
          disputeId: dispute.id,
          decision: "full_refund",
          buyerAmount: "1000",
          sellerAmount: "0",
          reasoning: "x",
          mediator: "GMEDIATOR",
        })
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it("rejects resolution amounts that don't sum to the remaining balance", async () => {
      const negotiating = await disputeInNegotiation();

      await expect(
        submitMediationDecision({
          disputeId: negotiating.id,
          decision: "split",
          buyerAmount: "400",
          sellerAmount: "400", // remaining is 1000 — doesn't sum
          reasoning: "x",
          mediator: "GMEDIATOR",
        })
      ).rejects.toThrow(InvalidResolutionAmountsError);
    });

    it("rejects a full_refund decision with a nonzero sellerAmount", async () => {
      const negotiating = await disputeInNegotiation();

      await expect(
        submitMediationDecision({
          disputeId: negotiating.id,
          decision: "full_refund",
          buyerAmount: "900",
          sellerAmount: "100",
          reasoning: "x",
          mediator: "GMEDIATOR",
        })
      ).rejects.toThrow(InvalidResolutionAmountsError);
    });

    it("full_refund: refunds the buyer only and resolves the dispute", async () => {
      vi.mocked(escrowCoordinator.partialRefundEscrow).mockResolvedValue({
        txHash: "tx-refund",
        ledger: 1,
        status: "partial_refunded",
        buyerAddress: "GBUYER",
        refundedAmount: "1000",
        remainingAmount: "0",
      });

      const negotiating = await disputeInNegotiation();
      const resolved = await submitMediationDecision({
        disputeId: negotiating.id,
        decision: "full_refund",
        buyerAmount: "1000",
        sellerAmount: "0",
        reasoning: "Item never arrived",
        mediator: "GMEDIATOR",
      });

      expect(resolved.status).toBe("resolved");
      expect(resolved.resolution?.type).toBe("full_refund");
      expect(escrowCoordinator.partialRefundEscrow).toHaveBeenCalledTimes(1);
      expect(escrowCoordinator.partialReleaseEscrow).not.toHaveBeenCalled();

      const buyerRep = await getDisputeReputation("GBUYER");
      const sellerRep = await getDisputeReputation("GSELLER");
      expect(buyerRep?.disputesResolvedFavorably).toBe(1);
      expect(sellerRep?.disputesResolvedUnfavorably).toBe(1);
    });

    it("release_to_seller: releases the seller only and resolves the dispute", async () => {
      vi.mocked(escrowCoordinator.partialReleaseEscrow).mockResolvedValue({
        txHash: "tx-release",
        ledger: 1,
        status: "partial_released",
        sellerAddress: "GSELLER",
        releasedAmount: "1000",
        remainingAmount: "0",
      });

      const negotiating = await disputeInNegotiation();
      const resolved = await submitMediationDecision({
        disputeId: negotiating.id,
        decision: "release_to_seller",
        buyerAmount: "0",
        sellerAmount: "1000",
        reasoning: "Delivery confirmed",
        mediator: "GMEDIATOR",
      });

      expect(resolved.status).toBe("resolved");
      expect(escrowCoordinator.partialReleaseEscrow).toHaveBeenCalledTimes(1);
      expect(escrowCoordinator.partialRefundEscrow).not.toHaveBeenCalled();
    });

    it("split: transfers both legs and resolves the dispute", async () => {
      vi.mocked(escrowCoordinator.partialRefundEscrow).mockResolvedValue({
        txHash: "tx-refund-split",
        ledger: 1,
        status: "partial_refunded",
        buyerAddress: "GBUYER",
        refundedAmount: "400",
        remainingAmount: "600",
      });
      vi.mocked(escrowCoordinator.partialReleaseEscrow).mockResolvedValue({
        txHash: "tx-release-split",
        ledger: 1,
        status: "partial_released",
        sellerAddress: "GSELLER",
        releasedAmount: "600",
        remainingAmount: "0",
      });

      const negotiating = await disputeInNegotiation();
      const resolved = await submitMediationDecision({
        disputeId: negotiating.id,
        decision: "split",
        buyerAmount: "400",
        sellerAmount: "600",
        reasoning: "Partial delivery",
        mediator: "GMEDIATOR",
      });

      expect(resolved.status).toBe("resolved");
      expect(escrowCoordinator.partialRefundEscrow).toHaveBeenCalledWith(
        expect.objectContaining({ amountStroops: "400" })
      );
      expect(escrowCoordinator.partialReleaseEscrow).toHaveBeenCalledWith(
        expect.objectContaining({ amountStroops: "600" })
      );
    });

    it("stays 'decided' (not 'resolved') when on-chain execution fails, and can be retried", async () => {
      vi.mocked(escrowCoordinator.partialRefundEscrow).mockRejectedValueOnce(new Error("Soroban RPC down"));

      const negotiating = await disputeInNegotiation();
      const afterFailure = await submitMediationDecision({
        disputeId: negotiating.id,
        decision: "full_refund",
        buyerAmount: "1000",
        sellerAmount: "0",
        reasoning: "x",
        mediator: "GMEDIATOR",
      });

      expect(afterFailure.status).toBe("decided");

      vi.mocked(escrowCoordinator.partialRefundEscrow).mockResolvedValue({
        txHash: "tx-retry",
        ledger: 1,
        status: "partial_refunded",
        buyerAddress: "GBUYER",
        refundedAmount: "1000",
        remainingAmount: "0",
      });

      const retried = await executeDecision(negotiating.id);
      expect(retried.status).toBe("resolved");
    });

    it("throws DisputeAlreadyResolvedError when deciding an already-resolved dispute", async () => {
      vi.mocked(escrowCoordinator.partialRefundEscrow).mockResolvedValue({
        txHash: "tx",
        ledger: 1,
        status: "partial_refunded",
        buyerAddress: "GBUYER",
        refundedAmount: "1000",
        remainingAmount: "0",
      });

      const negotiating = await disputeInNegotiation();
      await submitMediationDecision({
        disputeId: negotiating.id,
        decision: "full_refund",
        buyerAmount: "1000",
        sellerAmount: "0",
        reasoning: "x",
        mediator: "GMEDIATOR",
      });

      await expect(
        submitMediationDecision({
          disputeId: negotiating.id,
          decision: "full_refund",
          buyerAmount: "1000",
          sellerAmount: "0",
          reasoning: "x again",
          mediator: "GMEDIATOR",
        })
      ).rejects.toThrow(DisputeAlreadyResolvedError);
    });
  });
});
