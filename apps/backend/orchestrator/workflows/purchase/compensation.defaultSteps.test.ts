/**
 * Unit tests for #35 — createDefaultPurchaseCompensationSteps: the real
 * fundEscrow/confirmPurchase/settleEscrow compensation steps wired to
 * payments/merchant clients, retry budget behavior, escrow-stuck DLQ push,
 * and compensation outcome persistence.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PurchaseContext } from "../../state/types.js";
import type { PaymentsCompensationClient } from "./paymentsCompensationClient.js";
import type { MerchantCancellationClient } from "./merchantCancellationClient.js";

vi.mock("../../state/workflow-transition-audit.js", () => ({
  insertWorkflowTransitionAudit: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../state/compensation-outcome.js", () => ({
  upsertCompensationOutcome: vi.fn().mockResolvedValue({}),
}));

vi.mock("../timeout.js", () => ({
  moveToDeadLetter: vi.fn().mockResolvedValue({}),
}));

import { insertWorkflowTransitionAudit } from "../../state/workflow-transition-audit.js";
import { upsertCompensationOutcome } from "../../state/compensation-outcome.js";
import { moveToDeadLetter } from "../timeout.js";
import {
  createDefaultPurchaseCompensationSteps,
  retryWithLeaseBudget,
  runCompensation,
  NonRetryableError,
} from "./compensation.js";

function makeContext(overrides: Partial<PurchaseContext> = {}): PurchaseContext {
  const now = new Date();
  return {
    workflowId: "order-1",
    delegationId: "del-1",
    userId: "usr-1",
    productId: "prod-1",
    merchantId: "merch-1",
    totalStroops: BigInt(1000),
    escrowContractId: "escrow-1",
    rejectionReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makePaymentsClient(overrides: Partial<PaymentsCompensationClient> = {}): PaymentsCompensationClient {
  return {
    release: vi.fn().mockResolvedValue({
      orderId: "order-1",
      escrowId: "42",
      status: "released",
      txHash: "tx-release",
      alreadySettled: false,
    }),
    refund: vi.fn().mockResolvedValue({
      orderId: "order-1",
      escrowId: "42",
      status: "refunded",
      txHash: "tx-refund",
      alreadySettled: false,
    }),
    ...overrides,
  };
}

function makeMerchantClient(overrides: Partial<MerchantCancellationClient> = {}): MerchantCancellationClient {
  return {
    cancel: vi.fn().mockResolvedValue({ merchantOrderId: "order-1", status: "cancelled" }),
    ...overrides,
  };
}

describe("retryWithLeaseBudget", () => {
  it("returns the result on first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryWithLeaseBudget(fn, { deadlineMs: 1000, sleep: vi.fn().mockResolvedValue(undefined) });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries after a failure and succeeds on a later attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await retryWithLeaseBudget(fn, { deadlineMs: 10_000, baseDelayMs: 10, sleep });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("stops retrying and throws the last error once the deadline would be exceeded", async () => {
    // Simulated clock: `sleep` advances a fake `now` by exactly the requested delay,
    // so elapsed-time bookkeeping is deterministic instead of depending on real
    // wall-clock time (which made this test flaky/slow under real setTimeout).
    let simulatedNow = 0;
    const fn = vi.fn().mockRejectedValue(new Error("still failing"));
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      simulatedNow += ms;
    });
    const now = () => simulatedNow;

    await expect(
      retryWithLeaseBudget(fn, { deadlineMs: 500, baseDelayMs: 100, maxDelayMs: 100, sleep, now })
    ).rejects.toThrow("still failing");

    // Bounded — must not retry forever.
    expect(fn.mock.calls.length).toBeGreaterThan(1);
    expect(fn.mock.calls.length).toBeLessThan(20);
  });

  it("never sleeps past the deadline (bounded by saga lease budget)", async () => {
    let simulatedNow = 0;
    const fn = vi.fn().mockRejectedValue(new Error("down"));
    const sleeps: number[] = [];
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      sleeps.push(ms);
      simulatedNow += ms;
    });
    const now = () => simulatedNow;

    await expect(
      retryWithLeaseBudget(fn, { deadlineMs: 1000, baseDelayMs: 100, maxDelayMs: 1000, sleep, now })
    ).rejects.toThrow();

    const totalSleep = sleeps.reduce((a, b) => a + b, 0);
    expect(totalSleep).toBeLessThan(1000);
  });

  it("fails fast on a NonRetryableError without consuming any retry budget", async () => {
    const fn = vi.fn().mockRejectedValue(new NonRetryableError("misconfigured"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      retryWithLeaseBudget(fn, { deadlineMs: 10_000, sleep })
    ).rejects.toThrow("misconfigured");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("createDefaultPurchaseCompensationSteps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("fundEscrow (release)", () => {
    it("calls paymentsClient.release with the workflowId as orderId", async () => {
      const paymentsClient = makePaymentsClient();
      const steps = createDefaultPurchaseCompensationSteps({
        paymentsClient,
        merchantClient: makeMerchantClient(),
      });
      const fundEscrow = steps.find((s) => s.name === "fundEscrow")!;

      const ctx = await fundEscrow.compensate(makeContext(), new Error("boom"));

      expect(paymentsClient.release).toHaveBeenCalledWith("order-1");
      expect(ctx.escrowContractId).toBeNull();
    });

    it("skips the release call entirely when the context has no escrow contract", async () => {
      const paymentsClient = makePaymentsClient();
      const steps = createDefaultPurchaseCompensationSteps({
        paymentsClient,
        merchantClient: makeMerchantClient(),
      });
      const fundEscrow = steps.find((s) => s.name === "fundEscrow")!;

      await fundEscrow.compensate(makeContext({ escrowContractId: null }), new Error("boom"));

      expect(paymentsClient.release).not.toHaveBeenCalled();
    });

    it("throws when the release outcome status is failed, so the step is recorded as failed", async () => {
      const paymentsClient = makePaymentsClient({
        release: vi.fn().mockResolvedValue({
          orderId: "order-1",
          escrowId: "42",
          status: "failed",
          txHash: null,
          alreadySettled: false,
          reason: "on-chain failure",
        }),
      });
      const steps = createDefaultPurchaseCompensationSteps({
        paymentsClient,
        merchantClient: makeMerchantClient(),
      });
      const fundEscrow = steps.find((s) => s.name === "fundEscrow")!;

      await expect(fundEscrow.compensate(makeContext(), new Error("boom"))).rejects.toThrow(/on-chain failure/);
    });

    it("treats alreadySettled:true as success without throwing (idempotent retry)", async () => {
      const paymentsClient = makePaymentsClient({
        release: vi.fn().mockResolvedValue({
          orderId: "order-1",
          escrowId: "42",
          status: "released",
          txHash: "tx-release",
          alreadySettled: true,
        }),
      });
      const steps = createDefaultPurchaseCompensationSteps({
        paymentsClient,
        merchantClient: makeMerchantClient(),
      });
      const fundEscrow = steps.find((s) => s.name === "fundEscrow")!;

      await expect(fundEscrow.compensate(makeContext(), new Error("boom"))).resolves.toBeDefined();
    });
  });

  describe("confirmPurchase (merchant cancel)", () => {
    it("calls merchantClient.cancel with the workflowId as the merchant order id", async () => {
      const merchantClient = makeMerchantClient();
      const steps = createDefaultPurchaseCompensationSteps({
        paymentsClient: makePaymentsClient(),
        merchantClient,
      });
      const confirmPurchase = steps.find((s) => s.name === "confirmPurchase")!;

      await confirmPurchase.compensate(makeContext(), new Error("boom"));

      expect(merchantClient.cancel).toHaveBeenCalledWith("order-1", "system_error");
    });

    it("soft-skips (does not throw) when the merchant client is not configured", async () => {
      const steps = createDefaultPurchaseCompensationSteps({
        paymentsClient: makePaymentsClient(),
        merchantClient: {
          async cancel() {
            throw new Error("MerchantCancellationClient not configured");
          },
        },
      });
      const confirmPurchase = steps.find((s) => s.name === "confirmPurchase")!;

      await expect(confirmPurchase.compensate(makeContext(), new Error("boom"))).resolves.toBeDefined();
    });

    it("throws when the merchant service actively rejects the cancellation", async () => {
      const merchantClient = makeMerchantClient({
        cancel: vi.fn().mockResolvedValue({
          merchantOrderId: "order-1",
          status: "failed",
          reason: "order already shipped",
        }),
      });
      const steps = createDefaultPurchaseCompensationSteps({
        paymentsClient: makePaymentsClient(),
        merchantClient,
      });
      const confirmPurchase = steps.find((s) => s.name === "confirmPurchase")!;

      await expect(confirmPurchase.compensate(makeContext(), new Error("boom"))).rejects.toThrow(
        /already shipped/
      );
    });
  });

  describe("settleEscrow (refund)", () => {
    it("calls paymentsClient.refund with the workflowId and a reason code", async () => {
      const paymentsClient = makePaymentsClient();
      const steps = createDefaultPurchaseCompensationSteps({
        paymentsClient,
        merchantClient: makeMerchantClient(),
      });
      const settleEscrow = steps.find((s) => s.name === "settleEscrow")!;

      await settleEscrow.compensate(makeContext(), new Error("settlement failed"));

      expect(paymentsClient.refund).toHaveBeenCalledWith("order-1", "system_error");
    });

    it("throws when the refund outcome status is failed", async () => {
      const paymentsClient = makePaymentsClient({
        refund: vi.fn().mockResolvedValue({
          orderId: "order-1",
          escrowId: "42",
          status: "failed",
          txHash: null,
          alreadySettled: false,
          reason: "refund tx rejected",
        }),
      });
      const steps = createDefaultPurchaseCompensationSteps({
        paymentsClient,
        merchantClient: makeMerchantClient(),
      });
      const settleEscrow = steps.find((s) => s.name === "settleEscrow")!;

      await expect(settleEscrow.compensate(makeContext(), new Error("boom"))).rejects.toThrow(/refund tx rejected/);
    });
  });
});

describe("runCompensation with real default steps (#35 integration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy path: all three steps succeed, outcome persisted as success, no DLQ push", async () => {
    const paymentsClient = makePaymentsClient();
    const merchantClient = makeMerchantClient();
    const steps = createDefaultPurchaseCompensationSteps({ paymentsClient, merchantClient });

    const result = await runCompensation(
      "order-1",
      ["fundEscrow", "confirmPurchase", "settleEscrow"],
      makeContext(),
      new Error("saga failed"),
      steps
    );

    expect(result.status).toBe("success");
    expect(result.escrowStuck).toBe(false);
    expect(moveToDeadLetter).not.toHaveBeenCalled();
    expect(upsertCompensationOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: "order-1", status: "success" })
    );
  });

  it("stuck refund: fundEscrow release fails -> escrowStuck true, outcome persisted as escrow_stuck, pushed to DLQ", async () => {
    const paymentsClient = makePaymentsClient({
      release: vi.fn().mockResolvedValue({
        orderId: "order-1",
        escrowId: "42",
        status: "failed",
        txHash: null,
        alreadySettled: false,
        reason: "Soroban RPC unavailable",
      }),
    });
    const merchantClient = makeMerchantClient();
    const steps = createDefaultPurchaseCompensationSteps({ paymentsClient, merchantClient });

    const result = await runCompensation(
      "order-1",
      ["fundEscrow"],
      makeContext(),
      new Error("saga failed"),
      steps
    );

    expect(result.status).toBe("partial_failure");
    expect(result.escrowStuck).toBe(true);
    expect(result.failedSteps).toEqual([
      { step: "fundEscrow", error: expect.stringContaining("Soroban RPC unavailable") },
    ]);

    expect(upsertCompensationOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: "order-1", status: "escrow_stuck" })
    );
    expect(moveToDeadLetter).toHaveBeenCalledTimes(1);
    const [dlqRecord, reason] = vi.mocked(moveToDeadLetter).mock.calls[0];
    expect(dlqRecord.orderId).toBe("order-1");
    expect(reason).toMatch(/fundEscrow/);
  });

  it("merchant-only failure does NOT mark escrowStuck or push to DLQ (only fundEscrow/settleEscrow are escrow-critical)", async () => {
    const paymentsClient = makePaymentsClient();
    const merchantClient = makeMerchantClient({
      cancel: vi.fn().mockResolvedValue({
        merchantOrderId: "order-1",
        status: "failed",
        reason: "merchant API down",
      }),
    });
    const steps = createDefaultPurchaseCompensationSteps({ paymentsClient, merchantClient });

    const result = await runCompensation(
      "order-1",
      ["confirmPurchase"],
      makeContext(),
      new Error("saga failed"),
      steps
    );

    expect(result.status).toBe("partial_failure");
    expect(result.escrowStuck).toBe(false);
    expect(moveToDeadLetter).not.toHaveBeenCalled();
  });

  it("writes a COMPENSATION_FAILED audit record for the stuck step in addition to the DLQ push", async () => {
    const paymentsClient = makePaymentsClient({
      refund: vi.fn().mockResolvedValue({
        orderId: "order-1",
        escrowId: "42",
        status: "failed",
        txHash: null,
        alreadySettled: false,
        reason: "refund rejected",
      }),
    });
    const steps = createDefaultPurchaseCompensationSteps({
      paymentsClient,
      merchantClient: makeMerchantClient(),
    });

    await runCompensation("order-1", ["settleEscrow"], makeContext(), new Error("boom"), steps);

    expect(insertWorkflowTransitionAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order-1",
        toState: "settleEscrow_compensation_failed",
        eventType: "COMPENSATION_FAILED",
      })
    );
  });

  it("is idempotent end-to-end: retried compensation with an already-settled outcome does not throw and reports success", async () => {
    const paymentsClient = makePaymentsClient({
      release: vi.fn().mockResolvedValue({
        orderId: "order-1",
        escrowId: "42",
        status: "released",
        txHash: "tx-release",
        alreadySettled: true, // simulates a retried compensation call
      }),
    });
    const steps = createDefaultPurchaseCompensationSteps({
      paymentsClient,
      merchantClient: makeMerchantClient(),
    });

    const result = await runCompensation("order-1", ["fundEscrow"], makeContext(), new Error("boom"), steps);

    expect(result.status).toBe("success");
    expect(result.escrowStuck).toBe(false);
  });
});
