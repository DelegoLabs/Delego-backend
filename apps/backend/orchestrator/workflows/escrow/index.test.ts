import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EscrowSagaContext } from "@delegolabs/types";
import { InMemorySagaStore, type SagaRecord } from "../../src/saga/index.js";
import { getInventoryReservationService } from "../../src/inventory/reservation.js";
import { createEscrowSagaCoordinator, type EscrowServices } from "./index.js";

vi.mock("../../src/inventory/reservation.js", () => {
  const service = {
    reserve: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  };
  return { getInventoryReservationService: vi.fn(() => service) };
});

const items = [{ sku: "item1", quantity: 1 }];

function createInitialContext(): EscrowSagaContext {
  return {
    sagaId: "saga-1",
    orderId: "order-1",
    status: "executing",
    step: "reserve_stock",
    payload: { items },
  };
}

function createServices(overrides: Partial<EscrowServices> = {}): EscrowServices {
  return {
    submitSorobanEscrow: vi.fn().mockResolvedValue({ escrowId: "escrow-123" }),
    refundSorobanEscrow: vi.fn().mockResolvedValue(undefined),
    recordOrderDb: vi.fn().mockResolvedValue(undefined),
    deleteOrderDb: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function runOptions(correlationId: string) {
  return { workflowType: "checkout" as const, correlationId };
}

describe("escrow workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("completes all four steps and reserves stock on the happy path", async () => {
    const services = createServices();
    const store = new InMemorySagaStore();

    const result = await createEscrowSagaCoordinator(store, services).run(
      "saga-1",
      "order-1",
      createInitialContext(),
      runOptions("corr-1"),
    );

    expect(result.status).toBe("completed");
    expect(result.context).toMatchObject({ step: "complete", status: "succeeded" });
    expect(getInventoryReservationService().reserve).toHaveBeenCalledWith(items);
    expect(getInventoryReservationService().release).not.toHaveBeenCalled();
    expect(services.submitSorobanEscrow).toHaveBeenCalledOnce();
    expect(services.recordOrderDb).toHaveBeenCalledOnce();
    expect(services.refundSorobanEscrow).not.toHaveBeenCalled();
    expect(services.deleteOrderDb).not.toHaveBeenCalled();
  });

  it.each([
    ["Soroban trustline missing for USD", "trustline"],
    ["Insufficient balance to fund escrow", "balance"],
  ])("compensates when escrow submission fails with %s", async (message) => {
    const services = createServices({
      submitSorobanEscrow: vi.fn().mockRejectedValue(new Error(message)),
    });
    const store = new InMemorySagaStore();

    const result = await createEscrowSagaCoordinator(store, services).run(
      "saga-1",
      "order-1",
      createInitialContext(),
      runOptions("corr-1"),
    );

    expect(result.status).toBe("compensated");
    expect(result.error).toBe(message);
    expect(getInventoryReservationService().release).toHaveBeenCalledWith(items);
    expect(services.refundSorobanEscrow).not.toHaveBeenCalled();
    expect(services.recordOrderDb).not.toHaveBeenCalled();
    expect((await store.get("saga-1"))?.status).toBe("compensated");
  });

  it("refunds escrow and releases stock when persisting the order fails", async () => {
    const services = createServices({
      recordOrderDb: vi.fn().mockRejectedValue(new Error("Database connection lost")),
    });
    const store = new InMemorySagaStore();

    const result = await createEscrowSagaCoordinator(store, services).run(
      "saga-1",
      "order-1",
      createInitialContext(),
      runOptions("corr-1"),
    );

    expect(result.status).toBe("compensated");
    expect(result.error).toBe("Database connection lost");
    expect(services.refundSorobanEscrow).toHaveBeenCalledWith("escrow-123");
    expect(getInventoryReservationService().release).toHaveBeenCalledWith(items);
    expect(services.deleteOrderDb).not.toHaveBeenCalled();
    expect(result.context).toMatchObject({ step: "submit_soroban_escrow" });
  });

  it("rolls back a recorded order and funded escrow during compensating-saga recovery", async () => {
    const services = createServices();
    const store = new InMemorySagaStore();
    const sagaId = "saga-recovery";
    const now = new Date();
    const context: EscrowSagaContext = {
      ...createInitialContext(),
      sagaId,
      status: "compensating",
      step: "complete",
      payload: { items, escrowId: "escrow-recovery" },
    };
    await store.create({
      sagaId,
      orderId: "order-1",
      workflowType: "checkout",
      status: "compensating",
      currentStep: null,
      completedSteps: ["reserve_stock", "submit_soroban_escrow", "record_order_db", "complete"].map(
        (stepName) => ({
          stepName,
          status: "completed" as const,
          output: context as Record<string, unknown>,
          completedAt: now.toISOString(),
          compensationAction: stepName,
        }),
      ),
      context,
      version: 0,
      correlationId: "corr-recovery",
      error: "downstream failure",
      expiresAt: new Date(now.getTime() + 60_000),
      claimExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const result = await createEscrowSagaCoordinator(store, services).resume(sagaId);

    expect(result.status).toBe("compensated");
    expect(services.deleteOrderDb).toHaveBeenCalledWith("order-1");
    expect(services.refundSorobanEscrow).toHaveBeenCalledWith("escrow-recovery");
    expect(getInventoryReservationService().release).toHaveBeenCalledWith(items);
    const persisted = (await store.get(sagaId)) as SagaRecord<EscrowSagaContext>;
    expect(persisted.completedSteps).toHaveLength(4);
    expect(persisted.completedSteps.every((step) => step.status === "compensated")).toBe(true);
  });
});
