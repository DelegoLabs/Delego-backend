import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractEscrowIdFromTx, submitContractInvocation } from "../escrowCoordinator/contractClient.js";
import { runBillingCycle } from "./billingScheduler.js";
import { resetChargeStore } from "./chargeStore.js";
import { resetPlanStore } from "./planStore.js";
import { cancelSubscription, createSubscription, createSubscriptionPlan } from "./service.js";
import { getSubscriptionStore, resetSubscriptionStore } from "./subscriptionStore.js";

vi.mock("../escrowCoordinator/contractClient.js", async () => {
  const actual = await vi.importActual<typeof import("../escrowCoordinator/contractClient.js")>(
    "../escrowCoordinator/contractClient.js"
  );
  return { ...actual, submitContractInvocation: vi.fn(), extractEscrowIdFromTx: vi.fn() };
});

const CONTRACT_ID = "CCONTRACTID000000000000000000000000000000000000000000000000";
const BUYER = "GBUYER00000000000000000000000000000000000000000000000000";
const SELLER = "GSELLER0000000000000000000000000000000000000000000000000";

function mockSuccessfulCharge() {
  vi.mocked(submitContractInvocation).mockResolvedValue({ hash: "tx", ledger: 1, success: true });
  vi.mocked(extractEscrowIdFromTx).mockResolvedValue("7");
}

describe("runBillingCycle", () => {
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

  it("renews a subscription whose period has ended", async () => {
    mockSuccessfulCharge();
    const plan = await createSubscriptionPlan({
      merchantId: SELLER,
      name: "Weekly",
      amount: "100",
      currency: "CTOKEN00000000000000000000000000000000000000000000000000",
      interval: "week",
    });
    const sub = await createSubscription({
      planId: plan.id,
      buyerAddress: BUYER,
      sellerAddress: SELLER,
      paymentMethod: { type: "escrow", escrowContractId: CONTRACT_ID },
    });

    const eightDaysLater = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const result = await runBillingCycle(eightDaysLater);

    expect(result.renewed.map((s) => s.id)).toContain(sub.id);
    expect(result.failed).toHaveLength(0);
  });

  it("does not renew a subscription whose period hasn't ended yet", async () => {
    mockSuccessfulCharge();
    const plan = await createSubscriptionPlan({
      merchantId: SELLER,
      name: "Monthly",
      amount: "100",
      currency: "CTOKEN00000000000000000000000000000000000000000000000000",
      interval: "month",
    });
    await createSubscription({
      planId: plan.id,
      buyerAddress: BUYER,
      sellerAddress: SELLER,
      paymentMethod: { type: "escrow", escrowContractId: CONTRACT_ID },
    });

    const result = await runBillingCycle(new Date());
    expect(result.renewed).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it("moves a subscription to 'failed' output when the renewal charge fails", async () => {
    mockSuccessfulCharge();
    const plan = await createSubscriptionPlan({
      merchantId: SELLER,
      name: "Weekly",
      amount: "100",
      currency: "CTOKEN00000000000000000000000000000000000000000000000000",
      interval: "week",
    });
    const sub = await createSubscription({
      planId: plan.id,
      buyerAddress: BUYER,
      sellerAddress: SELLER,
      paymentMethod: { type: "escrow", escrowContractId: CONTRACT_ID },
    });

    vi.mocked(submitContractInvocation).mockResolvedValue({ hash: "tx-fail", ledger: 0, success: false });
    const eightDaysLater = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const result = await runBillingCycle(eightDaysLater);

    expect(result.failed.map((s) => s.id)).toContain(sub.id);
  });

  it("finalizes a scheduled cancellation once the period ends, without billing it again", async () => {
    mockSuccessfulCharge();
    const plan = await createSubscriptionPlan({
      merchantId: SELLER,
      name: "Weekly",
      amount: "100",
      currency: "CTOKEN00000000000000000000000000000000000000000000000000",
      interval: "week",
    });
    const sub = await createSubscription({
      planId: plan.id,
      buyerAddress: BUYER,
      sellerAddress: SELLER,
      paymentMethod: { type: "escrow", escrowContractId: CONTRACT_ID },
    });
    await cancelSubscription(sub.id, { atPeriodEnd: true });
    vi.mocked(submitContractInvocation).mockClear();

    const eightDaysLater = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const result = await runBillingCycle(eightDaysLater);

    expect(result.cancelled.map((s) => s.id)).toContain(sub.id);
    expect(result.renewed).toHaveLength(0);
    expect(submitContractInvocation).not.toHaveBeenCalled();

    const finalState = await getSubscriptionStore().findById(sub.id);
    expect(finalState?.status).toBe("cancelled");
  });

  it("converts a trial to its first paid period once the trial ends", async () => {
    mockSuccessfulCharge();
    const plan = await createSubscriptionPlan({
      merchantId: SELLER,
      name: "Trial plan",
      amount: "100",
      currency: "CTOKEN00000000000000000000000000000000000000000000000000",
      interval: "month",
      trialDays: 7,
    });
    const sub = await createSubscription({
      planId: plan.id,
      buyerAddress: BUYER,
      sellerAddress: SELLER,
      paymentMethod: { type: "escrow", escrowContractId: CONTRACT_ID },
    });
    expect(sub.status).toBe("trialing");
    expect(submitContractInvocation).not.toHaveBeenCalled();

    const afterTrial = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const result = await runBillingCycle(afterTrial);

    expect(result.renewed.map((s) => s.id)).toContain(sub.id);
    const finalState = await getSubscriptionStore().findById(sub.id);
    expect(finalState?.status).toBe("active");
    expect(submitContractInvocation).toHaveBeenCalledWith(expect.objectContaining({ method: "deposit" }));
  });
});
