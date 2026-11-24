import { z } from "zod";
import { SERVICE_AUTH_HEADER, tracedFetch } from "@delegolabs/utils";
import type {
  AgentDefinition,
  ApiResponse,
  TransactionRequest,
  TransactionResult,
} from "@delegolabs/types";
import type { AgentContext } from "../src/tools/registry.js";
import {
  checkDelegationSpendLimit,
  type SpendVelocityGuard,
  type SpendVelocityPolicy,
} from "../src/tools/spendVelocityGuard.js";

export const paymentAgentDefinition: AgentDefinition = {
  id: "payment-agent",
  role: "payment",
  name: "Payment Agent",
  description: "Executes payments within delegated spending policies",
  version: "0.0.1",
};

export interface PaymentAgentContext extends AgentContext {
  delegationId: string;
  walletId: string;
  delegationLimitPerTransactionStroops?: string | null;
  spendVelocityPolicy: SpendVelocityPolicy;
  spendVelocityGuard: Pick<SpendVelocityGuard, "check" | "recordSpend">;
}

export interface PaymentRequest {
  contractId: string;
  method: string;
  args: unknown[];
  amountStroops: string;
  memo?: string;
  argTypes?: string[];
}

export type PaymentAgentResult =
  | {
      status: "completed";
      approvalRequired: false;
      amountStroops: string;
      transaction: TransactionResult;
    }
  | {
      status: "awaiting_approval";
      approvalRequired: true;
      amountStroops: string;
      approvalThresholdStroops: string;
    }
  | {
      status: "failed";
      approvalRequired: false;
      amountStroops?: string;
      error: {
        code:
          | "INVALID_PAYMENT_REQUEST"
          | "DELEGATION_LIMIT_EXCEEDED"
          | "SPEND_VELOCITY_LIMIT_EXCEEDED"
          | "WALLET_SERVICE_ERROR"
          | "WALLET_TRANSACTION_FAILED";
        message: string;
      };
    };

export class PaymentSpendRecordingError extends Error {
  constructor(
    readonly transaction: TransactionResult,
    readonly causeValue: unknown,
  ) {
    const detail = causeValue instanceof Error ? causeValue.message : String(causeValue);
    super(`Payment ${transaction.hash} was submitted, but its spend could not be recorded: ${detail}`);
    this.name = "PaymentSpendRecordingError";
  }
}

class WalletServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletServiceError";
  }
}

const paymentRequestSchema = z
  .object({
    contractId: z.string().trim().min(1),
    method: z.string().trim().min(1),
    args: z.array(z.unknown()),
    amountStroops: z.string().regex(/^\d+$/).refine((value) => BigInt(value) > 0n),
    memo: z.string().optional(),
    argTypes: z.array(z.string()).optional(),
  })
  .strict();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTransactionResult(value: unknown): value is TransactionResult {
  return (
    isRecord(value) &&
    typeof value.hash === "string" &&
    typeof value.ledger === "number" &&
    typeof value.success === "boolean"
  );
}

async function submitToWalletService(
  request: TransactionRequest,
): Promise<TransactionResult> {
  const serviceToken = process.env.PAYMENTS_WALLET_SERVICE_TOKEN;
  if (!serviceToken?.trim()) {
    throw new WalletServiceError("PAYMENTS_WALLET_SERVICE_TOKEN is not configured");
  }

  const walletServiceUrl = process.env.WALLET_SERVICE_URL ?? "http://localhost:3012";
  let response: Response;
  try {
    response = await tracedFetch(
      `${walletServiceUrl.replace(/\/+$/, "")}/transactions/submit`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [SERVICE_AUTH_HEADER]: serviceToken,
          "x-delego-user-id": request.userId ?? "",
        },
        body: JSON.stringify(request),
      },
    );
  } catch (error) {
    throw new WalletServiceError(
      `Wallet service request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch (error) {
    throw new WalletServiceError(
      `Could not read wallet service response: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(responseText);
  } catch {
    throw new WalletServiceError(
      `Wallet service returned invalid JSON (status ${response.status})`,
    );
  }

  if (!isRecord(body)) {
    throw new WalletServiceError("Wallet service returned an invalid response");
  }

  const envelope = body as Partial<ApiResponse<unknown>>;
  const errorMessage =
    isRecord(envelope.error) && typeof envelope.error.message === "string"
      ? envelope.error.message
      : undefined;
  if (!response.ok || envelope.error) {
    throw new WalletServiceError(
      errorMessage ?? `Wallet service returned status ${response.status}`,
    );
  }
  if (!isTransactionResult(envelope.data)) {
    throw new WalletServiceError("Wallet service returned an invalid transaction result");
  }

  return envelope.data;
}

function failed(
  code: Extract<PaymentAgentResult, { status: "failed" }>["error"]["code"],
  message: string,
  amountStroops?: string,
): PaymentAgentResult {
  return {
    status: "failed",
    approvalRequired: false,
    ...(amountStroops === undefined ? {} : { amountStroops }),
    error: { code, message },
  };
}

/**
 * Validate delegated limits, request any required human approval, and submit
 * approved transactions through the wallet service.
 */
export async function runPaymentAgent(
  context: PaymentAgentContext,
  paymentRequest: PaymentRequest,
): Promise<PaymentAgentResult> {
  const parsedRequest = paymentRequestSchema.safeParse(paymentRequest);
  if (!parsedRequest.success) {
    return failed(
      "INVALID_PAYMENT_REQUEST",
      parsedRequest.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  const request = parsedRequest.data;

  if (
    !context.userId.trim() ||
    !context.walletAddress.trim() ||
    !context.walletId.trim() ||
    !context.delegationId.trim()
  ) {
    return failed(
      "INVALID_PAYMENT_REQUEST",
      "Payment agent context is incomplete",
      request.amountStroops,
    );
  }

  const delegationCheck = checkDelegationSpendLimit(
    request.amountStroops,
    context.spendingLimitRemainingStroops,
    context.delegationLimitPerTransactionStroops,
  );
  if (!delegationCheck.allowed) {
    return failed(
      "DELEGATION_LIMIT_EXCEEDED",
      delegationCheck.reason ?? "Delegation limit exceeded",
      request.amountStroops,
    );
  }

  const velocityCheck = await context.spendVelocityGuard.check(
    context.userId,
    request.amountStroops,
    context.spendVelocityPolicy,
  );
  if (!velocityCheck.allowed) {
    return failed(
      "SPEND_VELOCITY_LIMIT_EXCEEDED",
      velocityCheck.reason ?? "Spend velocity limit exceeded",
      request.amountStroops,
    );
  }
  if (velocityCheck.requiresBiometric) {
    return {
      status: "awaiting_approval",
      approvalRequired: true,
      amountStroops: request.amountStroops,
      approvalThresholdStroops: context.spendVelocityPolicy.requireBiometricAboveStroops,
    };
  }

  const transactionRequest: TransactionRequest = {
    sourceAddress: context.walletAddress,
    contractId: request.contractId,
    method: request.method,
    args: request.args,
    memo: request.memo ?? "Payment agent execution",
    ...(request.argTypes ? { argTypes: request.argTypes } : {}),
    userId: context.userId,
    walletId: context.walletId,
    delegationId: context.delegationId,
    amountStroops: request.amountStroops,
  };

  let transaction: TransactionResult;
  try {
    transaction = await submitToWalletService(transactionRequest);
  } catch (error) {
    if (error instanceof WalletServiceError) {
      return failed("WALLET_SERVICE_ERROR", error.message, request.amountStroops);
    }
    throw error;
  }
  if (!transaction.success) {
    return failed(
      "WALLET_TRANSACTION_FAILED",
      `Wallet service reported transaction ${transaction.hash} as unsuccessful`,
      request.amountStroops,
    );
  }

  try {
    await context.spendVelocityGuard.recordSpend(context.userId, request.amountStroops);
  } catch (error) {
    throw new PaymentSpendRecordingError(transaction, error);
  }

  return {
    status: "completed",
    approvalRequired: false,
    amountStroops: request.amountStroops,
    transaction,
  };
}
