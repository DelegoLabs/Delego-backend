/**
 * Partial Refund API — service logic (Issue #46).
 *
 * Validates the requested amount against the escrow's remaining balance
 * (fundedAmount - alreadyReleased - alreadyRefunded), triggers the on-chain
 * partial-refund contract call, and records the outcome to the audit log.
 */

import { createLogger } from "@delegolabs/utils";
import { escrowCoordinator, InsufficientEscrowBalanceError } from "../escrowCoordinator/index.js";
import { getEscrowContractId } from "../../escrow/config.js";
import { recordAuditEvent } from "./auditLog.js";
import { notifyPartialRefundExecuted } from "./notifications.js";
import type { PartialRefundRequest } from "./types.js";

const log = createLogger("payments:disputes:partial-refund", process.env.LOG_LEVEL ?? "info");

export class InvalidPartialRefundAmountError extends Error {
  constructor(amount: string) {
    super(`Partial refund amount must be a positive integer (stroops); received "${amount}"`);
    this.name = "InvalidPartialRefundAmountError";
  }
}

export interface PartialRefundOutcome {
  escrowId: string;
  success: boolean;
  transactionHash?: string;
  refundedAmount: string;
  remainingAmount: string;
  error?: string;
}

function parseAmount(amount: string): bigint {
  if (!/^[0-9]+$/.test(amount)) {
    throw new InvalidPartialRefundAmountError(amount);
  }
  const value = BigInt(amount);
  if (value <= 0n) {
    throw new InvalidPartialRefundAmountError(amount);
  }
  return value;
}

/**
 * Executes a {@link PartialRefundRequest}.
 *
 * Throws {@link InvalidPartialRefundAmountError} or
 * {@link InsufficientEscrowBalanceError} (re-exported from the escrow
 * coordinator) for validation failures — callers (e.g. the HTTP route)
 * should map both to `400 Bad Request`.
 */
export async function executePartialRefund(request: PartialRefundRequest): Promise<PartialRefundOutcome> {
  // Validates the request is well-formed before touching the balance/chain.
  const requested = parseAmount(request.amount);

  const balance = await escrowCoordinator.getRemainingBalance(request.escrowId);
  const contractId = getEscrowContractId();

  // Fail fast on insufficient balance — checked here (not just inside the
  // coordinator's on-chain call) so a bad request never reaches the chain.
  if (requested > BigInt(balance.remainingAmount)) {
    throw new InsufficientEscrowBalanceError(request.escrowId, balance.remainingAmount, request.amount);
  }

  await recordAuditEvent({
    escrowId: request.escrowId,
    eventType: "partial_refund_requested",
    actor: request.requestedBy,
    details: { amount: request.amount, reason: request.reason, evidence: request.evidence ?? [] },
  });

  // escrowCoordinator.partialRefundEscrow throws InsufficientEscrowBalanceError
  // when amount > remaining — propagated to the caller unchanged.
  const result = await escrowCoordinator.partialRefundEscrow({
    escrowId: request.escrowId,
    escrowContractId: contractId,
    callerAddress: request.requestedBy,
    amountStroops: request.amount,
    reason: request.reason,
  });

  const outcome: PartialRefundOutcome = {
    escrowId: request.escrowId,
    success: result.status === "partial_refunded",
    transactionHash: result.status === "partial_refunded" ? result.txHash : undefined,
    refundedAmount: result.refundedAmount,
    remainingAmount: result.remainingAmount,
    error: result.status === "failed" ? "Partial refund transaction failed on-chain" : undefined,
  };

  await recordAuditEvent({
    escrowId: request.escrowId,
    eventType: outcome.success ? "partial_refund_executed" : "partial_refund_failed",
    actor: request.requestedBy,
    details: { ...outcome },
  });

  await notifyPartialRefundExecuted(balance.orderId, request.escrowId, {
    requestedBy: request.requestedBy,
    reason: request.reason,
    ...outcome,
  });

  if (!outcome.success) {
    log.warn("Partial refund execution failed", { escrowId: request.escrowId });
  }

  return outcome;
}
