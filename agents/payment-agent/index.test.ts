import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SERVICE_AUTH_HEADER } from "@delegolabs/utils";
import type { SpendVelocityCheckResult, SpendVelocityGuard } from "../src/tools/spendVelocityGuard.js";
import {
  PaymentSpendRecordingError,
  runPaymentAgent,
  type PaymentAgentContext,
  type PaymentRequest,
} from "./index.js";

const paymentRequest: PaymentRequest = {
  contractId: "C".padEnd(56, "A"),
  method: "transfer",
  args: ["destination", "100"],
  amountStroops: "100",
  memo: "Agent payment",
};

const allowedVelocity: SpendVelocityCheckResult = {
  allowed: true,
  requiresBiometric: false,
  hourlyTransactions: 0,
  hourlyVolume: 0n,
  dailyVolume: 0n,
};

function makeContext(
  velocityResult: SpendVelocityCheckResult = allowedVelocity,
  overrides: Partial<PaymentAgentContext> = {},
) {
  const spendVelocityGuard: Pick<SpendVelocityGuard, "check" | "recordSpend"> = {
    check: vi.fn(async () => velocityResult),
    recordSpend: vi.fn(async () => undefined),
  };
  const context: PaymentAgentContext = {
    userId: "user-1",
    walletAddress: "G".padEnd(56, "A"),
    walletId: "wallet-1",
    delegationId: "delegation-1",
    spendingLimitRemainingStroops: "1000",
    delegationLimitPerTransactionStroops: "500",
    spendVelocityPolicy: {
      maxHourlyTransactions: 10,
      maxHourlyVolumeStroops: "1000",
      maxDailyVolumeStroops: "5000",
      requireBiometricAboveStroops: "250",
    },
    spendVelocityGuard,
    ...overrides,
  };
  return { context, spendVelocityGuard };
}

function mockWalletResponse(
  body: unknown = {
    data: { hash: "tx-hash", ledger: 42, success: true },
    error: null,
  },
  status = 200,
) {
  const fetchMock = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("runPaymentAgent", () => {
  beforeEach(() => {
    vi.stubEnv("WALLET_SERVICE_URL", "http://wallet.test/");
    vi.stubEnv("PAYMENTS_WALLET_SERVICE_TOKEN", "service-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("blocks payments above a delegation per-transaction limit before checking velocity", async () => {
    const { context, spendVelocityGuard } = makeContext(undefined, {
      delegationLimitPerTransactionStroops: "99",
    });
    const fetchMock = mockWalletResponse();

    const result = await runPaymentAgent(context, paymentRequest);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "DELEGATION_LIMIT_EXCEEDED" },
    });
    expect(spendVelocityGuard.check).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks payments above the remaining delegation allowance", async () => {
    const { context, spendVelocityGuard } = makeContext(undefined, {
      spendingLimitRemainingStroops: "50",
    });
    const fetchMock = mockWalletResponse();

    const result = await runPaymentAgent(context, paymentRequest);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "DELEGATION_LIMIT_EXCEEDED" },
    });
    expect(spendVelocityGuard.check).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a velocity breach without calling the wallet service", async () => {
    const { context } = makeContext({
      ...allowedVelocity,
      allowed: false,
      reason: "Hourly volume exceeded",
    });
    const fetchMock = mockWalletResponse();

    const result = await runPaymentAgent(context, paymentRequest);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "SPEND_VELOCITY_LIMIT_EXCEEDED", message: "Hourly volume exceeded" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns awaiting_approval above the approval threshold without submitting or recording spend", async () => {
    const { context, spendVelocityGuard } = makeContext({
      ...allowedVelocity,
      requiresBiometric: true,
    });
    const fetchMock = mockWalletResponse();

    const result = await runPaymentAgent(context, paymentRequest);

    expect(result).toEqual({
      status: "awaiting_approval",
      approvalRequired: true,
      amountStroops: "100",
      approvalThresholdStroops: "250",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spendVelocityGuard.recordSpend).not.toHaveBeenCalled();
  });

  it("submits an auto-approved payment to the wallet service and records spend after success", async () => {
    const { context, spendVelocityGuard } = makeContext();
    const fetchMock = mockWalletResponse();

    const result = await runPaymentAgent(context, paymentRequest);

    expect(result).toEqual({
      status: "completed",
      approvalRequired: false,
      amountStroops: "100",
      transaction: { hash: "tx-hash", ledger: 42, success: true },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://wallet.test/transactions/submit");
    expect(new Headers(options?.headers).get(SERVICE_AUTH_HEADER)).toBe("service-token");
    expect(JSON.parse(String(options?.body))).toMatchObject({
      sourceAddress: context.walletAddress,
      userId: context.userId,
      walletId: context.walletId,
      delegationId: context.delegationId,
      amountStroops: "100",
    });
    expect(spendVelocityGuard.recordSpend).toHaveBeenCalledWith(context.userId, "100");
  });

  it("returns a structured failure when the wallet service rejects the submission", async () => {
    const { context, spendVelocityGuard } = makeContext();
    mockWalletResponse(
      { data: null, error: { code: "SUBMISSION_FAILED", message: "Rejected by wallet" } },
      400,
    );

    const result = await runPaymentAgent(context, paymentRequest);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "WALLET_SERVICE_ERROR", message: "Rejected by wallet" },
    });
    expect(spendVelocityGuard.recordSpend).not.toHaveBeenCalled();
  });

  it("does not record a transaction the wallet service reports as unsuccessful", async () => {
    const { context, spendVelocityGuard } = makeContext();
    mockWalletResponse({
      data: { hash: "tx-hash", ledger: 42, success: false },
      error: null,
    });

    const result = await runPaymentAgent(context, paymentRequest);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "WALLET_TRANSACTION_FAILED" },
    });
    expect(spendVelocityGuard.recordSpend).not.toHaveBeenCalled();
  });

  it("surfaces spend recording failure with the already-submitted transaction", async () => {
    const { context, spendVelocityGuard } = makeContext();
    vi.mocked(spendVelocityGuard.recordSpend).mockRejectedValue(new Error("Redis unavailable"));
    mockWalletResponse();

    await expect(runPaymentAgent(context, paymentRequest)).rejects.toBeInstanceOf(
      PaymentSpendRecordingError,
    );
  });

  it("rejects malformed or zero-value payment requests without invoking dependencies", async () => {
    const { context, spendVelocityGuard } = makeContext();
    const fetchMock = mockWalletResponse();

    const result = await runPaymentAgent(context, { ...paymentRequest, amountStroops: "0" });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "INVALID_PAYMENT_REQUEST" },
    });
    expect(spendVelocityGuard.check).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
