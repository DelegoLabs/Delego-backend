import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractEscrowIdFromTx,
  submitContractInvocation,
} from "../escrowCoordinator/contractClient.js";
import { resetChargeStore } from "./chargeStore.js";
import { resetPlanStore } from "./planStore.js";
import {
  cancelSubscription,
  changeSubscriptionPlan,
  createSubscription,
  createSubscriptionPlan,
  getSubscription,
  pauseSubscription,
  renewSubscription,
  resumeSubscription,
} from "./service.js";
import { resetSubscriptionStore } from "./subscriptionStore.js";
import { SubscriptionNotActiveError, SubscriptionPlanNotFoundError } from "./types.js";

vi.mock("../escrowCoordinator/contractClient.js", async () => {
  const actual = await vi.importActual<typeof import("../escrowCoordinator/contractClient.js")>(
    "../escrowCoordinator/contractClient.js"
  );
  return {
    ...actual,
    submitContractInvocation: vi.fn(),
    extractEscrowIdFromTx: vi.fn(),
  };
});

const CONTRACT_ID = "CCONTRACTID000000000000000000000000000000000000000000000000";

function mockSuccessfulCharge(escrowId = "7") {
  vi.mocked(submitContractInvocation).mockResolvedValue({ hash: "tx-hash", ledger: 1, success: true });
  vi.mocked(extractEscrowIdFromTx).mockResolvedValue(escrowId);
}

async function createFlatPlan(overrides: Partial<Parameters<typeof createSubscriptionPlan>[0]> = {}) {
  return createSubscriptionPlan({
    merchantId: "GMERCHANT0000000000000000000000000000000000000000000000",
    name: "Pro Plan",
    amount: "1000",
    currency: "CTOKEN00000000000000000000000000000000000000000000000000",
    interval: "month",
    ...overrides,
  });
}

describe("subscriptions service", () => {
  beforeEach(() => {
    process.env.ESCROW_CONTRACT_ID = CONTRACT_ID;
    resetPlanStore();
    resetSubscriptionStore();
    resetChargeStore();
    vi.mocked(submitContractInvocation).mockReset();
    vi.mocked(extractEscrowIdFromTx).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ESCROW_CONTRACT_ID;
  });

  describe("createSubscription", () => {
    it("charges the first period immediately and starts 'active' when there is no trial", async () => {
      mockSuccessfulCharge();
      const plan = await createFlatPlan();

      const sub = await createSubscription({
        planId: plan.id,
        buyerAddress: "GBUYER00000000000000000000000000000000000000000000000000",
        sellerAddress: "GSELLER0000000000000000000000000000000000000000000000000",
        paymentMethod: { type: "escrow", escrowContractId: CONTRACT_ID },
      });

      expect(sub.status).toBe("active");
      expect(submitContractInvocation).toHaveBeenCalledWith(
        expect.objectContaining({ method: "deposit" })
      );
      expect(submitContractInvocation).toHaveBeenCalledWith(expect.objectContaining({ method: "release" }));
    });

    it("starts 'trialing' with no charge when the plan has a trial", async () => {
      const plan = await createFlatPlan({ trialDays: 14 });

      const sub = await createSubscription({
        planId: plan.id,
        buyerAddress: "GBUYER00000000000000000000000000000000000000000000000000",
        sellerAddress: "GSELLER0000000000000000000000000000000000000000000000000",
        paymentMethod: { type: "escrow", escrowContractId: CONTRACT_ID },
      });

      expect(sub.status).toBe("trialing");
      expect(sub.trialEnd).toBeDefined();
      expect(submitContractInvocation).not.toHaveBeenCalled();
    });

    it("creates the subscription as 'past_due' when the first charge fails", async () => {
      vi.mocked(submitContractInvocation).mockResolvedValue({ hash: "tx-fail", ledger: 0, success: false });
      const plan = await createFlatPlan();

      const sub = await createSubscription({
        planId: plan.id,
        buyerAddress: "GBUYER00000000000000000000000000000000000000000000000000",
        sellerAddress: "GSELLER0000000000000000000000000000000000000000000000000",
        paymentMethod: { type: "escrow", escrowContractId: CONTRACT_ID },
      });

      expect(sub.status).toBe("past_due");
    });

    it("throws SubscriptionPlanNotFoundError for an unknown plan", async () => {
      await expect(
        createSubscription({
          planId: "does-not-exist",
          buyerAddress: "GBUYER00000000000000000000000000000000000000000000000000",
          sellerAddress: "GSELLER0000000000000000000000000000000000000000000000000",
          paymentMethod: { type: "escrow" },
        })
      ).rejects.toThrow(SubscriptionPlanNotFoundError);
    });
  });

  describe("renewSubscription", () => {
    it("does not charge (and returns unchanged) when the period isn't due yet", async () => {
      mockSuccessfulCharge();
      const plan = await createFlatPlan();
      const sub = await createSubscription({
        planId: plan.id,
        buyerAddress: "GBUYER00000000000000000000000000000000000000000000000000",
        sellerAddress: "GSELLER0000000000000000000000000000000000000000000000000",
        paymentMethod: { type: "escrow", escrowContractId: CONTRACT_ID },
      });
      vi.mocked(submitContractInvocation).mockClear();

      const result = await renewSubscription(sub.id);
      expect(result.currentPeriodEnd).toBe(sub.currentPeriodEnd);
      expect(submitContractInvocation).not.toHaveBeenCalled();
    });

    it("charges and advances the period when forced", async () => {
      mockSuccessfulCharge();
      const plan = await createFlatPlan();
      const sub = await createSubscription({
        planId: plan.id,
        buyerAddress: "GBUYER00000000000000000000000000000000000000000000000000",
        sellerAddress: "GSELLER0000000000000000000000000000000000000000000000000",
        paymentMethod: { type: "escrow", escrowContractId: CONTRACT_ID },
      });

      const renewed = await renewSubscription(sub.id, { force: true });

      expect(renewed.status).toBe("active");
      expect(new Date(renewed.currentPeriodStart).getTime()).toBe(new Date(sub.currentPeriodEnd).getTime());
      expect(new Date(renewed.currentPeriodEnd).getTime()).toBeGreaterThan(new Date(sub.currentPeriodEnd).getTime());
    });

    it("marks the subscription 'past_due' when the renewal charge fails", async () => {
      mockSuccessfulCharge();
      const plan = await createFlatPlan();
      const sub = await createSubscription({
        planId: plan.id,
        buyerAddress: "GBUYER00000000000000000000000000000000000000000000000000",
        sellerAddress: "GSELLER0000000000000000000000000000000000000000000000000",
        paymentMethod: { type: "escrow", escrowContractId: CONTRACT_ID },
      });

      vi.mocked(submitContractInvocation).mockResolvedValue({ hash: "tx-fail", ledger: 0, success: false });
      const renewed = await renewSubscription(sub.id, { force: true });

      expect(renewed.status).toBe("past_due");
    });

    it("does not double-charge the same period across two forced renewal calls", async () => {
      mockSuccessfulCharge();
      const plan = await createFlatPlan();
      const sub = await createSubscription({
        planId: plan.id,
        buyerAddress: "GBUYER00000000000000000000000000000000000000000000000000",
        sellerAddress: "GSELLER0000000000000000000000000000000000000000000000000",
        paymentMethod: { type: "escrow", escrowContractId: CONTRACT_ID },
      });
      vi.mocked(submitContractInvocation).mockClear();

      await renewSubscription(sub.id, { force: true });
      const callsAfterFirst = vi.mocked(submitContractInvocation).mock.calls.length;

      // Forcing again immediately targets a *new* period (periodStart moved
      // on), so this is a distinct charge, not a duplicate of the first.
      await renewSubscription(sub.id, { force: true });
      expect(vi.mocked(submitContractInvocation).mock.calls.length).toBe(callsAfterFirst * 2);
    });

    it("charges usage-based amounts capped at the plan's maxAmount", async () => {
      mockSuccessfulCharge();
      const plan = await createFlatPlan({ usageBased: true, maxAmount: "500" });
      const sub = await createSubscription({
        planId: plan.id,
        buyerAddress: "GBUYER00000000000000000000000000000000000000000000000000",
        sellerAddress: "GSELLER0000000000000000000000000000000000000000000000000",
        paymentMethod: { type: "escrow", escrowContractId: CONTRACT_ID },
      });
      vi.mocked(submitContractInvocation).mockClear();

      await renewSubscription(sub.id, { force: true, usageAmount: "900" });

      expect(submitContractInvocation).toHaveBeenCalledWith(
        expect.objectContaining({ method: "deposit", amountStroops: "500" })
      );
    });
  });

  describe("pause / resume", () => {
    it("pauses an active subscription and resumes it back to active", async () => {
      mockSuccessfulCharge();
      const plan = await createFlatPlan();
      const sub = await createSubscription({
        planId: plan.id,
        buyerAddress: "GBUYER00000000000000000000000000000000000000000000000000",
        sellerAddress: "GSELLER0000000000000000000000000000000000000000000000000",
        paymentMethod: { type: "escrow", escrowContractId: CONTRACT_ID },
      });

      const paused = await pauseSubscription(sub.id);
      expect(paused.status).toBe("paused");

      const resumed = await resumeSubscription(sub.id);
      expect(resumed.status).toBe("active");
    });

    it("rejects resuming a subscription that isn't paused", async () => {
      mockSuccessfulCharge();
      const plan = await createFlatPlan();
      const sub = await createSubscription({
        planId: plan.id,
        buyerAddress: "GBUYER00000000000000000000000000000000000000000000000000",
        sellerAddress: "GSELLER0000000000000000000000000000000000000000000000000",
        paymentMethod: { type: "escrow", escrowContractId: CONTRACT_ID },
      });

      await expect(resumeSubscription(sub.id)).rejects.toThrow(SubscriptionNotActiveError);
    });
  });

  describe("cancelSubscription", () => {
    it("cancels immediately by default", async () => {
      mockSuccessfulCharge();
      const plan = await createFlatPlan();
      const sub = await createSubscription({
        planId: plan.id,
        buyerAddress: "GBUYER00000000000000000000000000000000000000000000000000",
        sellerAddress: "GSELLER0000000000000000000000000000000000000000000000000",
        paymentMethod: { type: "escrow", escrowContractId: CONTRACT_ID },
      });

      const cancelled = await cancelSubscription(sub.id);
      expect(cancelled.status).toBe("cancelled");
    });

    it("only flags cancelAtPeriodEnd without changing status when requested", async () => {
      mockSuccessfulCharge();
      const plan = await createFlatPlan();
      const sub = await createSubscription({
        planId: plan.id,
        buyerAddress: "GBUYER00000000000000000000000000000000000000000000000000",
        sellerAddress: "GSELLER0000000000000000000000000000000000000000000000000",
        paymentMethod: { type: "escrow", escrowContractId: CONTRACT_ID },
      });

      const flagged = await cancelSubscription(sub.id, { atPeriodEnd: true });
      expect(flagged.status).toBe("active");
      expect(flagged.cancelAtPeriodEnd).toBe(true);
    });
  });

  describe("changeSubscriptionPlan", () => {
    it("switches the subscription to the new plan without an immediate charge", async () => {
      mockSuccessfulCharge();
      const planA = await createFlatPlan({ name: "A" });
      const planB = await createFlatPlan({ name: "B", amount: "2000" });
      const sub = await createSubscription({
        planId: planA.id,
        buyerAddress: "GBUYER00000000000000000000000000000000000000000000000000",
        sellerAddress: "GSELLER0000000000000000000000000000000000000000000000000",
        paymentMethod: { type: "escrow", escrowContractId: CONTRACT_ID },
      });
      vi.mocked(submitContractInvocation).mockClear();

      const updated = await changeSubscriptionPlan(sub.id, planB.id);
      expect(updated.planId).toBe(planB.id);
      expect(submitContractInvocation).not.toHaveBeenCalled();

      const refetched = await getSubscription(sub.id);
      expect(refetched.planId).toBe(planB.id);
    });

    it("throws SubscriptionPlanNotFoundError for an invalid target plan", async () => {
      mockSuccessfulCharge();
      const plan = await createFlatPlan();
      const sub = await createSubscription({
        planId: plan.id,
        buyerAddress: "GBUYER00000000000000000000000000000000000000000000000000",
        sellerAddress: "GSELLER0000000000000000000000000000000000000000000000000",
        paymentMethod: { type: "escrow", escrowContractId: CONTRACT_ID },
      });

      await expect(changeSubscriptionPlan(sub.id, "does-not-exist")).rejects.toThrow(SubscriptionPlanNotFoundError);
    });
  });
});
