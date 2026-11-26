import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVICE_AUTH_HEADER } from "@delegolabs/utils";
import { InMemorySagaStore, type SagaRecord } from "../../src/saga/index.js";
import { getInventoryReservationService } from "../../src/inventory/reservation.js";
import {
  checkoutWorkflow,
  createCheckoutSagaCoordinator,
  createCheckoutWorkflowInput,
  type CheckoutContext,
} from "./index.js";

vi.mock("../../src/inventory/reservation.js", () => {
  const service = {
    reserve: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  };
  return { getInventoryReservationService: vi.fn(() => service) };
});

const originalToken = process.env.ORCHESTRATOR_PAYMENTS_SERVICE_TOKEN;
const originalPaymentsUrl = process.env.PAYMENTS_URL;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function depositResponse(escrowId = "escrow-123"): Response {
  return jsonResponse({
    data: { txHash: "deposit-tx", ledger: 100, success: true, escrowId },
    error: null,
  });
}

function checkoutInput() {
  return createCheckoutWorkflowInput(
    {
      orderId: "order-1",
      sourceAddress: "GSource",
      buyerAddress: "GBuyer",
      sellerAddress: "GSeller",
      userId: "body-supplied-user",
    },
    "authenticated-user",
  );
}

const inventoryItems = [{ merchantId: "merchant-1", productId: "product-1", quantity: 2 }];

describe("checkout workflow", () => {
  beforeEach(() => {
    process.env.ORCHESTRATOR_PAYMENTS_SERVICE_TOKEN = "payments-test-token";
    process.env.PAYMENTS_URL = "http://payments.test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    if (originalToken === undefined) delete process.env.ORCHESTRATOR_PAYMENTS_SERVICE_TOKEN;
    else process.env.ORCHESTRATOR_PAYMENTS_SERVICE_TOKEN = originalToken;
    if (originalPaymentsUrl === undefined) delete process.env.PAYMENTS_URL;
    else process.env.PAYMENTS_URL = originalPaymentsUrl;
  });

  it("completes the saga after reserving inventory and confirming the escrow deposit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(depositResponse());
    vi.stubGlobal("fetch", fetchMock);
    const store = new InMemorySagaStore();

    const result = await checkoutWorkflow(
      { ...checkoutInput(), inventoryItems },
      createCheckoutSagaCoordinator(store),
      "saga-happy",
    );

    expect(result.status).toBe("completed");
    expect(result.context).toMatchObject({
      orderId: "order-1",
      escrowId: "escrow-123",
      confirmed: true,
    });
    expect(getInventoryReservationService().reserve).toHaveBeenCalledWith([
      { ...inventoryItems[0], orderId: "order-1" },
    ]);
    expect(getInventoryReservationService().release).not.toHaveBeenCalled();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://payments.test/escrow/deposit");
    expect(init.headers).toMatchObject({
      [SERVICE_AUTH_HEADER]: "payments-test-token",
      "x-delego-user-id": "authenticated-user",
    });
    expect(JSON.parse(init.body as string)).toMatchObject({ orderId: "order-1" });
    expect(JSON.parse(init.body as string)).not.toHaveProperty("userId");
  });

  it.each([
    ["TRUSTLINE_MISSING", "Destination trustline missing for USD"],
    ["INSUFFICIENT_BALANCE", "Insufficient balance in source account"],
  ])("compensates and releases inventory when Payments rejects the deposit (%s)", async (code, message) => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: null, error: { code, message } }, 400),
    );
    vi.stubGlobal("fetch", fetchMock);
    const store = new InMemorySagaStore();

    const result = await checkoutWorkflow(
      { ...checkoutInput(), inventoryItems },
      createCheckoutSagaCoordinator(store),
      `saga-${code.toLowerCase()}`,
    );

    expect(result.status).toBe("compensated");
    expect(result.error).toBe(message);
    expect(getInventoryReservationService().release).toHaveBeenCalledWith([
      { ...inventoryItems[0], orderId: "order-1" },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("http://payments.test/escrow/deposit");
    expect((await store.get(`saga-${code.toLowerCase()}`))?.status).toBe("compensated");
  });

  it("refunds the funded escrow when recovery compensates a completed checkout", async () => {
    const fetchMock = vi.fn().mockResolvedValue(depositResponse());
    vi.stubGlobal("fetch", fetchMock);
    const store = new InMemorySagaStore();
    const sagaId = "saga-compensation";
    const now = new Date();
    const context: CheckoutContext = {
      orderId: "order-1",
      sourceAddress: "GSource",
      buyerAddress: "GBuyer",
      sellerAddress: "GSeller",
      userId: "authenticated-user",
      escrowId: "escrow-123",
      confirmed: true,
    };
    await store.create({
      sagaId,
      orderId: "order-1",
      workflowType: "checkout",
      status: "compensating",
      currentStep: null,
      completedSteps: [
        {
          stepName: "deposit-escrow",
          status: "completed",
          output: context,
          completedAt: now.toISOString(),
          compensationAction: "deposit-escrow",
        },
        {
          stepName: "confirm-checkout",
          status: "completed",
          output: context,
          completedAt: now.toISOString(),
          compensationAction: "confirm-checkout",
        },
      ],
      context,
      version: 0,
      correlationId: "corr-compensation",
      error: "downstream failure",
      expiresAt: new Date(now.getTime() + 60_000),
      claimExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const result = await createCheckoutSagaCoordinator(store).resume(sagaId);

    expect(result.status).toBe("compensated");
    expect(result.context).toMatchObject({ escrowId: null, confirmed: false });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://payments.test/escrow/escrow-123/refund");
    expect(JSON.parse(init.body as string)).toEqual({ sourceAddress: "GSource" });
    const persisted = (await store.get(sagaId)) as SagaRecord<CheckoutContext>;
    expect(persisted.completedSteps.map((step) => step.status)).toEqual([
      "compensated",
      "compensated",
    ]);
  });

  it("releases reserved inventory when the saga run itself throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(depositResponse()));
    const store = new InMemorySagaStore();
    vi.spyOn(store, "create").mockRejectedValue(new Error("Saga store unavailable"));

    await expect(
      checkoutWorkflow(
        { ...checkoutInput(), inventoryItems },
        createCheckoutSagaCoordinator(store),
        "saga-store-failure",
      ),
    ).rejects.toThrow("Saga store unavailable");

    expect(getInventoryReservationService().release).toHaveBeenCalledWith([
      { ...inventoryItems[0], orderId: "order-1" },
    ]);
    vi.restoreAllMocks();
  });
});
