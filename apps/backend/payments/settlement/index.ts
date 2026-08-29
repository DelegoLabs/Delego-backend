import { createLogger } from "@delegolabs/utils";
import { escrowService } from "../escrow/index.js";
import { getTransactionFeeEstimate } from "../escrow/wallet-client.js";
import { publishPaymentEvent } from "../events/index.js";
import {
  findPaymentRecordByOrderId,
  updatePaymentRecord,
} from "../src/escrowCoordinator/paymentRecordStore.js";
import type { PaymentRecord } from "../src/escrowCoordinator/types.js";
import type { RefundReasonCode } from "../escrow/types.js";

const log = createLogger("payments:settlement", process.env.LOG_LEVEL ?? "info");

export interface SettlementCommand {
  orderId: string;
  escrowId: string;
  releaseTo: string;
  amountStroops: string;
  deliveryProofId: string;
}

export interface SettlementResult {
  orderId: string;
  txHash: string;
  status: "submitted" | "confirmed" | "failed";
}

export interface SettlementDryRunResult {
  orderId: string;
  canSettle: boolean;
  simulationFee?: string;
  reason?: string;
}

/**
 * Dry-run settlement validation and simulation path.
 * Validates settlement inputs and simulates fee estimation without submitting
 * transactions to the wallet/ledger queue or publishing completion events.
 */
export async function dryRunSettlement(
  orderIdOrCommand: string | Partial<SettlementCommand>
): Promise<SettlementDryRunResult> {
  const orderId =
    typeof orderIdOrCommand === "string"
      ? orderIdOrCommand.trim()
      : orderIdOrCommand?.orderId?.trim() ?? "";

  log.info("Starting settlement dry-run simulation", { orderId });

  if (!orderId) {
    return {
      orderId: "",
      canSettle: false,
      reason: "Invalid or missing order ID",
    };
  }

  const sourceAddress = process.env.SETTLEMENT_SOURCE_ADDRESS;
  if (!sourceAddress) {
    log.warn("Dry-run failed: missing SETTLEMENT_SOURCE_ADDRESS", { orderId });
    return {
      orderId,
      canSettle: false,
      reason: "SETTLEMENT_SOURCE_ADDRESS environment variable is not configured",
    };
  }

  try {
    const escrowId =
      (typeof orderIdOrCommand === "object" && orderIdOrCommand.escrowId) ||
      (await resolveEscrowForOrder(orderId));
    const releaseTo =
      (typeof orderIdOrCommand === "object" && orderIdOrCommand.releaseTo) ||
      (await resolveReleaseAddress(orderId));
    const amountStroops =
      (typeof orderIdOrCommand === "object" && orderIdOrCommand.amountStroops) ||
      (await resolveSettlementAmount(orderId));

    if (!escrowId || escrowId.trim() === "") {
      return {
        orderId,
        canSettle: false,
        reason: "Invalid or missing escrow ID",
      };
    }

    // Simulate transaction fee estimation without submitting transaction to queue
    const feeEstimate = await getTransactionFeeEstimate();
    const simulationFee = String(feeEstimate.recommendedFeeStroops);

    log.info("Settlement dry-run simulation successful", {
      orderId,
      escrowId,
      releaseTo,
      amountStroops,
      simulationFee,
    });

    return {
      orderId,
      canSettle: true,
      simulationFee,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error("Settlement dry-run simulation failed", {
      orderId,
      error: reason,
    });
    return {
      orderId,
      canSettle: false,
      reason,
    };
  }
}

// ─── #35 Order-level escrow compensation (release / refund) ────────────────
//
// These wrap escrowService (the same Soroban escrow client coordinateSettlement
// already uses below) behind an order-id keyed, idempotent API — the shape the
// orchestrator's compensation module needs, since a saga only knows the orderId,
// not the escrowId. Idempotency comes from payment_records.status: if a prior
// call already drove the record to "released"/"refunded", a retry (e.g. from
// the orchestrator's bounded compensation retry loop) returns the recorded
// outcome instead of re-invoking the contract, so a retried compensation step
// can never double-release or double-refund the same escrow.

export type SettlementOutcomeStatus = "released" | "refunded" | "failed" | "no_escrow";

export interface SettlementOutcome {
  orderId: string;
  escrowId: string | null;
  status: SettlementOutcomeStatus;
  txHash: string | null;
  /** True when this call found the escrow already in the target terminal state. */
  alreadySettled: boolean;
  reason?: string;
}

async function loadPaymentRecordForCompensation(orderId: string): Promise<PaymentRecord | null> {
  try {
    return await findPaymentRecordByOrderId(orderId);
  } catch (err) {
    log.error("Failed to load payment record for compensation", {
      orderId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Releases escrow funds to the seller for a completed order. Idempotent per
 * orderId: a payment_records row already in status "released" short-circuits
 * to the previously recorded outcome without calling the contract again.
 *
 * Used both by the normal settlement path (delivery confirmed → release) and,
 * with the same idempotency guarantee, by the orchestrator's escrow
 * compensation flow (#35) when a saga step downstream of ESCROW_FUNDED needs
 * to retry a release after a partial failure.
 */
export async function settleOrder(orderId: string): Promise<SettlementOutcome> {
  const trimmedOrderId = orderId?.trim();
  if (!trimmedOrderId) {
    throw new Error("orderId is required");
  }

  const record = await loadPaymentRecordForCompensation(trimmedOrderId);
  if (!record || !record.escrowId) {
    return {
      orderId: trimmedOrderId,
      escrowId: record?.escrowId ?? null,
      status: "no_escrow",
      txHash: null,
      alreadySettled: false,
      reason: "No funded escrow found for order",
    };
  }

  if (record.status === "released") {
    log.info("settleOrder: already released, returning recorded outcome", {
      orderId: trimmedOrderId,
      escrowId: record.escrowId,
    });
    return {
      orderId: trimmedOrderId,
      escrowId: record.escrowId,
      status: "released",
      txHash: record.releaseTxHash,
      alreadySettled: true,
    };
  }

  if (record.status === "refunded") {
    // Terminal in the other direction — refuse rather than silently no-op, since
    // releasing after a refund would double-pay the seller from an empty escrow.
    return {
      orderId: trimmedOrderId,
      escrowId: record.escrowId,
      status: "failed",
      txHash: null,
      alreadySettled: false,
      reason: `Cannot release order ${trimmedOrderId}: escrow was already refunded`,
    };
  }

  const sourceAddress = process.env.SETTLEMENT_SOURCE_ADDRESS;
  if (!sourceAddress) {
    throw new Error("SETTLEMENT_SOURCE_ADDRESS environment variable is not configured");
  }

  try {
    const result = await escrowService.release({ sourceAddress, escrowId: record.escrowId });

    if (!result.success) {
      await updatePaymentRecord(record.id, {
        status: "failed",
        failureReason: "Release transaction failed on-chain",
      });
      return {
        orderId: trimmedOrderId,
        escrowId: record.escrowId,
        status: "failed",
        txHash: result.txHash,
        alreadySettled: false,
        reason: "Release transaction failed on-chain",
      };
    }

    await updatePaymentRecord(record.id, {
      status: "released",
      releaseTxHash: result.txHash,
      failureReason: null,
    });

    await publishPaymentEvent({
      type: "escrow_released",
      orderId: trimmedOrderId,
      payload: { escrowId: record.escrowId, txHash: result.txHash },
      occurredAt: new Date().toISOString(),
    }).catch((err) =>
      log.error("settleOrder: event publish failed (non-fatal)", {
        orderId: trimmedOrderId,
        error: err instanceof Error ? err.message : String(err),
      })
    );

    return {
      orderId: trimmedOrderId,
      escrowId: record.escrowId,
      status: "released",
      txHash: result.txHash,
      alreadySettled: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown release error";
    log.error("settleOrder: release failed", { orderId: trimmedOrderId, error: message });
    await updatePaymentRecord(record.id, { status: "failed", failureReason: message }).catch(() => {});
    return {
      orderId: trimmedOrderId,
      escrowId: record.escrowId,
      status: "failed",
      txHash: null,
      alreadySettled: false,
      reason: message,
    };
  }
}

/**
 * Refunds escrow funds to the buyer for a cancelled/failed order. Idempotent per
 * orderId in the same way as settleOrder: a record already "refunded" returns
 * the recorded outcome instead of resubmitting the refund transaction.
 *
 * This is the release-side counterpart the orchestrator's compensation module
 * calls to reverse a purchase saga after ESCROW_FUNDED (#35).
 */
export async function refundOrder(
  orderId: string,
  reasonCode: RefundReasonCode = "system_error"
): Promise<SettlementOutcome> {
  const trimmedOrderId = orderId?.trim();
  if (!trimmedOrderId) {
    throw new Error("orderId is required");
  }

  const record = await loadPaymentRecordForCompensation(trimmedOrderId);
  if (!record || !record.escrowId) {
    return {
      orderId: trimmedOrderId,
      escrowId: record?.escrowId ?? null,
      status: "no_escrow",
      txHash: null,
      alreadySettled: false,
      reason: "No funded escrow found for order",
    };
  }

  if (record.status === "refunded") {
    log.info("refundOrder: already refunded, returning recorded outcome", {
      orderId: trimmedOrderId,
      escrowId: record.escrowId,
    });
    return {
      orderId: trimmedOrderId,
      escrowId: record.escrowId,
      status: "refunded",
      txHash: record.refundTxHash,
      alreadySettled: true,
    };
  }

  if (record.status === "released") {
    return {
      orderId: trimmedOrderId,
      escrowId: record.escrowId,
      status: "failed",
      txHash: null,
      alreadySettled: false,
      reason: `Cannot refund order ${trimmedOrderId}: escrow was already released`,
    };
  }

  const sourceAddress = process.env.SETTLEMENT_SOURCE_ADDRESS;
  if (!sourceAddress) {
    throw new Error("SETTLEMENT_SOURCE_ADDRESS environment variable is not configured");
  }

  try {
    const result = await escrowService.refund({
      sourceAddress,
      escrowId: record.escrowId,
      refundReasonCode: reasonCode,
    });

    if (!result.success) {
      await updatePaymentRecord(record.id, {
        status: "failed",
        failureReason: "Refund transaction failed on-chain",
      });
      return {
        orderId: trimmedOrderId,
        escrowId: record.escrowId,
        status: "failed",
        txHash: result.txHash,
        alreadySettled: false,
        reason: "Refund transaction failed on-chain",
      };
    }

    await updatePaymentRecord(record.id, {
      status: "refunded",
      refundTxHash: result.txHash,
      failureReason: null,
    });

    await publishPaymentEvent({
      type: "escrow_refunded",
      orderId: trimmedOrderId,
      payload: { escrowId: record.escrowId, txHash: result.txHash, reasonCode },
      occurredAt: new Date().toISOString(),
    }).catch((err) =>
      log.error("refundOrder: event publish failed (non-fatal)", {
        orderId: trimmedOrderId,
        error: err instanceof Error ? err.message : String(err),
      })
    );

    return {
      orderId: trimmedOrderId,
      escrowId: record.escrowId,
      status: "refunded",
      txHash: result.txHash,
      alreadySettled: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown refund error";
    log.error("refundOrder: refund failed", { orderId: trimmedOrderId, error: message });
    await updatePaymentRecord(record.id, { status: "failed", failureReason: message }).catch(() => {});
    return {
      orderId: trimmedOrderId,
      escrowId: record.escrowId,
      status: "failed",
      txHash: null,
      alreadySettled: false,
      reason: message,
    };
  }
}

export async function coordinateSettlement(orderId: string): Promise<void> {
  log.info("Starting settlement coordination", { orderId });

  let ledgerResult: Awaited<ReturnType<typeof escrowService.release>> | null =
    null;

  try {
    const escrowId = await resolveEscrowForOrder(orderId);
    const releaseTo = await resolveReleaseAddress(orderId);
    const amountStroops = await resolveSettlementAmount(orderId);

    log.info("Releasing escrow funds", {
      orderId,
      escrowId,
      releaseTo,
      amountStroops,
    });

    const sourceAddress = process.env.SETTLEMENT_SOURCE_ADDRESS;
    if (!sourceAddress) {
      throw new Error(
        "SETTLEMENT_SOURCE_ADDRESS environment variable is not configured"
      );
    }

    // ── Ledger release (critical path) ──────────────────────────────────────
    // Any error here is fatal and should propagate to the caller.
    ledgerResult = await escrowService.release({ sourceAddress, escrowId });

    log.info("Settlement release submitted to ledger", {
      orderId,
      escrowId,
      txHash: ledgerResult.txHash,
    });

    // ── Event publish (non-critical, fire-and-forget) ────────────────────────
    // The funds have already moved on-chain.  A transient Redis failure must
    // NOT propagate back as a settlement failure — that would cause callers to
    // retry the ledger release and double-spend.  We log the error and move on.
    publishPaymentEvent({
      type: "settlement_complete",
      orderId,
      payload: {
        escrowId,
        releaseTo,
        amountStroops,
        txHash: ledgerResult.txHash,
      },
      occurredAt: new Date().toISOString(),
    }).catch((err) =>
      log.error("Settlement event publish failed (non-fatal)", {
        orderId,
        error: err instanceof Error ? err.message : String(err),
      })
    );

    log.info("Settlement coordination completed successfully", {
      orderId,
      txHash: ledgerResult.txHash,
    });
  } catch (err) {
    log.error("Settlement coordination failed", {
      orderId,
      error: err instanceof Error ? err.message : "Unknown error",
    });

    // Only emit a failure event when the ledger release itself failed
    // (i.e. ledgerResult is still null).  If we already have a txHash, the
    // funds moved and the failure is in downstream logic — don't mislead
    // consumers with a "failed" settlement event.
    if (!ledgerResult) {
      publishPaymentEvent({
        type: "settlement_complete",
        orderId,
        payload: {
          error: err instanceof Error ? err.message : "Unknown error",
          status: "failed",
        },
        occurredAt: new Date().toISOString(),
      }).catch((publishErr) =>
        log.error("Settlement failure event publish failed", {
          orderId,
          error:
            publishErr instanceof Error
              ? publishErr.message
              : String(publishErr),
        })
      );
    }

    throw err;
  }
}

async function resolveEscrowForOrder(orderId: string): Promise<string> {
  return `${orderId}`;
}

async function resolveReleaseAddress(orderId: string): Promise<string> {
  return process.env.SETTLEMENT_RELEASE_ADDRESS ?? orderId;
}

async function resolveSettlementAmount(_orderId: string): Promise<string> {
  return "0";
}
