import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { escrowCoordinator } from "../escrowCoordinator/index.js";
import { resetAuditLogStore } from "./auditLog.js";
import { getDisputeStore, resetDisputeStore } from "./disputeStore.js";
import { findAndEscalateBreachedDisputes } from "./slaEscalation.js";

vi.mock("../escrowCoordinator/index.js", async () => {
  const actual = await vi.importActual<typeof import("../escrowCoordinator/index.js")>(
    "../escrowCoordinator/index.js"
  );
  return {
    ...actual,
    escrowCoordinator: {
      getEscrowStatus: vi.fn(),
      getRemainingBalance: vi.fn().mockResolvedValue({
        escrowId: "42",
        orderId: "order-1",
        buyerAddress: "GBUYER",
        sellerAddress: "GSELLER",
        totalAmount: "1000",
        releasedAmount: "0",
        refundedAmount: "0",
        remainingAmount: "1000",
      }),
      releaseEscrow: vi.fn(),
      refundEscrow: vi.fn(),
      disputeEscrow: vi.fn(),
      partialRefundEscrow: vi.fn(),
      partialReleaseEscrow: vi.fn(),
      fundEscrow: vi.fn(),
    },
  };
});

async function seedDispute(overrides: { slaDeadline: string; status?: "open" | "negotiation" | "decided" }) {
  const store = getDisputeStore();
  const dispute = await store.create({
    escrowId: "42",
    orderId: "order-1",
    initiatedBy: "GBUYER",
    reason: "x",
    slaDeadline: overrides.slaDeadline,
  });
  if (overrides.status) {
    return store.update(dispute.id, { status: overrides.status });
  }
  return dispute;
}

describe("findAndEscalateBreachedDisputes", () => {
  beforeEach(() => {
    resetDisputeStore();
    resetAuditLogStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("escalates an open dispute whose SLA deadline has passed", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const dispute = await seedDispute({ slaDeadline: past });

    const result = await findAndEscalateBreachedDisputes(new Date());

    expect(result.scanned).toBe(1);
    expect(result.escalated).toHaveLength(1);
    expect(result.escalated[0].id).toBe(dispute.id);
  });

  it("does not escalate a dispute whose SLA deadline hasn't passed yet", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    await seedDispute({ slaDeadline: future });

    const result = await findAndEscalateBreachedDisputes(new Date());

    expect(result.scanned).toBe(0);
  });

  it("does not escalate a dispute that already reached 'decided' or 'resolved'", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    await seedDispute({ slaDeadline: past, status: "decided" });

    const result = await findAndEscalateBreachedDisputes(new Date());

    expect(result.scanned).toBe(0);
  });

  it("is idempotent: a second scan does not re-escalate the same dispute", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    await seedDispute({ slaDeadline: past });

    const first = await findAndEscalateBreachedDisputes(new Date());
    const second = await findAndEscalateBreachedDisputes(new Date());

    expect(first.scanned).toBe(1);
    expect(second.scanned).toBe(0);
  });
});
