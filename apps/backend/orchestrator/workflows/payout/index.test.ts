import { describe, expect, it, vi } from "vitest";
import type { TrustlineCheckResult } from "@delegolabs/types";
import { InMemorySagaStore } from "../../src/saga/index.js";
import {
  createPayoutSagaCoordinator,
  generateTrustlineSetupInstructions,
  type PayoutSagaContext,
  type PayoutSagaServices,
} from "./index.js";

function trustlineResult(overrides: Partial<TrustlineCheckResult> = {}): TrustlineCheckResult {
  return {
    account: "GMerchant",
    assetCode: "USD",
    assetIssuer: "GIssuer",
    trustlineEstablished: true,
    authorized: true,
    currentBalance: "10000000",
    creditLimit: "9223372036854775807",
    ...overrides,
  };
}

function createContext(assetOverrides: Partial<PayoutSagaContext["payload"]> = {}): PayoutSagaContext {
  return {
    sagaId: "saga-payout-1",
    step: "preflight_trustline_check",
    status: "pending",
    payload: {
      escrowId: "escrow-1",
      orderId: "order-1",
      merchantAddress: "GMerchant",
      sourceAddress: "GSource",
      assetCode: "USD",
      assetIssuer: "GIssuer",
      amountStroops: "10000000",
      ...assetOverrides,
    },
  };
}

function createServices(overrides: Partial<PayoutSagaServices> = {}): PayoutSagaServices {
  return {
    checkTrustline: vi.fn().mockResolvedValue(trustlineResult()),
    notifyMerchant: vi.fn().mockResolvedValue(undefined),
    releaseEscrow: vi.fn().mockResolvedValue({
      txHash: "payout-tx-1",
      ledger: 12345,
      success: true,
    }),
    recordPayoutDb: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function runOptions(correlationId: string) {
  return { workflowType: "checkout" as const, correlationId };
}

describe("payout workflow", () => {
  it("releases escrow and records the payout after a successful trustline check", async () => {
    const check = trustlineResult({ currentBalance: "0", creditLimit: "unlimited" });
    const services = createServices({ checkTrustline: vi.fn().mockResolvedValue(check) });
    const store = new InMemorySagaStore();

    const result = await createPayoutSagaCoordinator(store, services).run(
      "saga-payout-1",
      "order-1",
      createContext(),
      runOptions("corr-1"),
    );

    expect(result.status).toBe("completed");
    expect(result.context).toMatchObject({
      step: "record_payout",
      status: "succeeded",
      payload: { txHash: "payout-tx-1", ledger: 12345, trustlineCheck: check },
    });
    expect(services.checkTrustline).toHaveBeenCalledWith("GMerchant", "USD", "GIssuer");
    expect(services.releaseEscrow).toHaveBeenCalledWith({
      sourceAddress: "GSource",
      escrowId: "escrow-1",
    });
    expect(services.recordPayoutDb).toHaveBeenCalledOnce();
    expect(services.notifyMerchant).not.toHaveBeenCalled();
  });

  it("skips trustline verification for native XLM payouts", async () => {
    const services = createServices();
    const store = new InMemorySagaStore();

    const result = await createPayoutSagaCoordinator(store, services).run(
      "saga-payout-xlm",
      "order-1",
      createContext({ assetCode: "XLM", assetIssuer: undefined }),
      runOptions("corr-xlm"),
    );

    expect(result.status).toBe("completed");
    expect(services.checkTrustline).not.toHaveBeenCalled();
    expect(services.releaseEscrow).toHaveBeenCalledOnce();
    expect(services.recordPayoutDb).toHaveBeenCalledOnce();
  });

  it("pauses the payout and notifies the merchant when the trustline is missing", async () => {
    const check = trustlineResult({ trustlineEstablished: false, currentBalance: "0" });
    const services = createServices({ checkTrustline: vi.fn().mockResolvedValue(check) });
    const store = new InMemorySagaStore();

    const result = await createPayoutSagaCoordinator(store, services).run(
      "saga-payout-missing-trustline",
      "order-1",
      createContext(),
      runOptions("corr-missing"),
    );

    expect(result.status).toBe("completed");
    expect(result.context.status).toBe("paused");
    expect(result.context.payload).toMatchObject({
      pauseReason: "MISSING_TRUSTLINE",
      trustlineCheck: check,
    });
    expect(services.notifyMerchant).toHaveBeenCalledWith({
      merchantAddress: "GMerchant",
      assetCode: "USD",
      assetIssuer: "GIssuer",
      instructions: generateTrustlineSetupInstructions("GMerchant", "USD", "GIssuer"),
      checkResult: check,
    });
    expect(services.releaseEscrow).not.toHaveBeenCalled();
    expect(services.recordPayoutDb).not.toHaveBeenCalled();
  });

  it("pauses the payout when the merchant trustline is unauthorized", async () => {
    const check = trustlineResult({ authorized: false });
    const services = createServices({ checkTrustline: vi.fn().mockResolvedValue(check) });
    const store = new InMemorySagaStore();

    const result = await createPayoutSagaCoordinator(store, services).run(
      "saga-payout-unauthorized",
      "order-1",
      createContext(),
      runOptions("corr-unauthorized"),
    );

    expect(result.context.status).toBe("paused");
    expect(result.context.payload.pauseReason).toBe("UNAUTHORIZED_TRUSTLINE");
    expect(services.notifyMerchant).toHaveBeenCalledOnce();
    expect(services.releaseEscrow).not.toHaveBeenCalled();
  });

  it.each([
    ["Insufficient balance for trustline check", "balance-check"],
    ["Trustline service unavailable", "trustline-check"],
  ])("compensates when the preflight check fails with %s", async (message, suffix) => {
    const services = createServices({
      checkTrustline: vi.fn().mockRejectedValue(new Error(message)),
    });
    const store = new InMemorySagaStore();

    const result = await createPayoutSagaCoordinator(store, services).run(
      `saga-payout-${suffix}`,
      "order-1",
      createContext(),
      runOptions(`corr-${suffix}`),
    );

    expect(result.status).toBe("compensated");
    expect(result.error).toBe(message);
    expect(services.notifyMerchant).not.toHaveBeenCalled();
    expect(services.releaseEscrow).not.toHaveBeenCalled();
    expect(services.recordPayoutDb).not.toHaveBeenCalled();
    expect((await store.get(`saga-payout-${suffix}`))?.status).toBe("compensated");
  });

  it("compensates without recording a payout when escrow release fails", async () => {
    const services = createServices({
      releaseEscrow: vi.fn().mockRejectedValue(new Error("Escrow release transaction failed")),
    });
    const store = new InMemorySagaStore();

    const result = await createPayoutSagaCoordinator(store, services).run(
      "saga-payout-release-failure",
      "order-1",
      createContext(),
      runOptions("corr-release"),
    );

    expect(result.status).toBe("compensated");
    expect(result.error).toBe("Escrow release transaction failed");
    expect(services.checkTrustline).toHaveBeenCalledOnce();
    expect(services.recordPayoutDb).not.toHaveBeenCalled();
    expect(result.context.payload).not.toHaveProperty("txHash");
  });

  it("compensates when a non-native asset is missing its issuer", async () => {
    const services = createServices();
    const store = new InMemorySagaStore();

    const result = await createPayoutSagaCoordinator(store, services).run(
      "saga-payout-missing-issuer",
      "order-1",
      createContext({ assetIssuer: undefined }),
      runOptions("corr-issuer"),
    );

    expect(result.status).toBe("compensated");
    expect(result.error).toBe("Asset issuer required for non-native asset USD");
    expect(services.checkTrustline).not.toHaveBeenCalled();
    expect(services.releaseEscrow).not.toHaveBeenCalled();
  });
});
