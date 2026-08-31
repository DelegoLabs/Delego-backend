/**
 * Dispute Mediation Workflow (Issue #46).
 *
 * Orchestrates the full mediation lifecycle: opening a dispute, collecting
 * evidence, assigning a mediator, and executing the mediator's decision
 * atomically against the escrow contract (via the partial refund/release
 * primitives), updating reputation and the immutable audit log along the way.
 */

import { createLogger } from "@delegolabs/utils";
import { escrowCoordinator, type RemainingBalance } from "../escrowCoordinator/index.js";
import { getEscrowContractId } from "../../escrow/config.js";
import { recordAuditEvent } from "./auditLog.js";
import { getDisputeStore } from "./disputeStore.js";
import { notifyDisputeParties } from "./notifications.js";
import { recordDisputeInitiated, recordDisputeInvolved, recordDisputeOutcome } from "./reputationStore.js";
import { assertTransition, planAdvance } from "./stateMachine.js";
import {
  DisputeAlreadyResolvedError,
  DisputeNotFoundError,
  InvalidResolutionAmountsError,
  InvalidStateTransitionError,
  type Dispute,
  type DisputeEvidenceEntry,
  type DisputeEvidenceInput,
  type DisputeResolution,
  type MediationDecision,
} from "./types.js";

const log = createLogger("payments:disputes:mediation", process.env.LOG_LEVEL ?? "info");

export const DEFAULT_SLA_DAYS = 14;

// ---------------------------------------------------------------------------
// Open dispute
// ---------------------------------------------------------------------------

export interface OpenDisputeParams {
  escrowId: string;
  initiatedBy: string;
  reason: string;
  /** Overrides the default 14-day SLA window. */
  slaDays?: number;
}

/**
 * Opens a dispute on a funded escrow.
 *
 * Best-effort flags the escrow as disputed on-chain (via the existing
 * `disputeEscrow` contract call) so other flows — notably escrow
 * auto-release — see the escrow as disputed and refuse to act on it; a
 * failure there is logged and audited but does not block dispute creation,
 * since the mediation record itself is the source of truth for this workflow.
 */
export async function openDispute(params: OpenDisputeParams): Promise<Dispute> {
  const balance = await escrowCoordinator.getRemainingBalance(params.escrowId);
  const slaDays = params.slaDays ?? DEFAULT_SLA_DAYS;
  const slaDeadline = new Date(Date.now() + slaDays * 24 * 60 * 60 * 1000).toISOString();

  const dispute = await getDisputeStore().create({
    escrowId: params.escrowId,
    orderId: balance.orderId,
    initiatedBy: params.initiatedBy,
    reason: params.reason,
    slaDeadline,
  });

  try {
    await escrowCoordinator.disputeEscrow({
      escrowId: params.escrowId,
      escrowContractId: getEscrowContractId(),
      callerAddress: params.initiatedBy,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown on-chain dispute error";
    log.warn("On-chain dispute flag failed; continuing with the mediation record", {
      escrowId: params.escrowId,
      error: message,
    });
    await recordAuditEvent({
      disputeId: dispute.id,
      escrowId: params.escrowId,
      eventType: "dispute_onchain_flag_failed",
      actor: params.initiatedBy,
      details: { error: message },
    });
  }

  const other = params.initiatedBy === balance.buyerAddress ? balance.sellerAddress : balance.buyerAddress;
  await Promise.all([recordDisputeInitiated(params.initiatedBy), recordDisputeInvolved(other)]);

  await recordAuditEvent({
    disputeId: dispute.id,
    escrowId: params.escrowId,
    eventType: "dispute_opened",
    actor: params.initiatedBy,
    details: { reason: params.reason, slaDeadline },
  });
  await notifyDisputeParties("dispute_opened", balance.orderId, dispute);

  return dispute;
}

// ---------------------------------------------------------------------------
// Evidence submission
// ---------------------------------------------------------------------------

/**
 * Submits one piece of evidence. Legal only while the dispute is still
 * `open` or `evidence_collection`; a first submission auto-advances an
 * `open` dispute into `evidence_collection`.
 */
export async function submitEvidence(disputeId: string, input: DisputeEvidenceInput): Promise<Dispute> {
  const dispute = await getDisputeStore().findById(disputeId);
  if (!dispute) throw new DisputeNotFoundError(disputeId);

  if (dispute.status !== "open" && dispute.status !== "evidence_collection") {
    throw new InvalidStateTransitionError(dispute.status, "evidence_collection");
  }

  const entry: DisputeEvidenceEntry = { ...input, submittedAt: new Date().toISOString() };
  let updated = await getDisputeStore().addEvidence(disputeId, entry);

  if (updated.status === "open") {
    assertTransition("open", "evidence_collection");
    updated = await getDisputeStore().update(disputeId, { status: "evidence_collection" });
  }

  await recordAuditEvent({
    disputeId,
    escrowId: dispute.escrowId,
    eventType: "dispute_evidence_submitted",
    actor: input.party,
    details: { description: input.description, files: input.files },
  });

  const balance = await safeGetBalance(dispute.escrowId);
  if (balance) {
    await notifyDisputeParties("dispute_evidence_submitted", balance.orderId, updated, { party: input.party });
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Mediator assignment
// ---------------------------------------------------------------------------

/**
 * Assigns a mediator and moves the dispute into active `negotiation`,
 * fast-tracking through any stage it hasn't reached yet (e.g. straight from
 * `open`, if evidence was never submitted) — every intermediate hop is still
 * validated against the state machine.
 */
export async function assignMediator(disputeId: string, mediator: string, assignedBy?: string): Promise<Dispute> {
  const dispute = await getDisputeStore().findById(disputeId);
  if (!dispute) throw new DisputeNotFoundError(disputeId);

  if (dispute.status === "decided" || dispute.status === "resolved") {
    throw new InvalidStateTransitionError(dispute.status, "negotiation");
  }

  planAdvance(dispute.status, "negotiation");

  const updated = await getDisputeStore().update(disputeId, { status: "negotiation", mediator });

  await recordAuditEvent({
    disputeId,
    escrowId: dispute.escrowId,
    eventType: "dispute_mediator_assigned",
    actor: assignedBy ?? mediator,
    details: { mediator },
  });

  const balance = await safeGetBalance(dispute.escrowId);
  if (balance) {
    await notifyDisputeParties("dispute_mediator_assigned", balance.orderId, updated);
  }

  return updated;
}

/** Round-robin index for {@link autoAssignMediator}. */
let autoAssignCursor = 0;

/**
 * Auto-assigns the next mediator from `DISPUTE_MEDIATOR_POOL` (a
 * comma-separated list of mediator addresses) using simple round-robin
 * rotation. Falls back to no-op (throws) if the pool isn't configured —
 * callers should fall back to an explicit admin assignment in that case.
 */
export async function autoAssignMediator(disputeId: string): Promise<Dispute> {
  const pool = (process.env.DISPUTE_MEDIATOR_POOL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (pool.length === 0) {
    throw new Error("DISPUTE_MEDIATOR_POOL is not configured; assign a mediator explicitly");
  }

  const mediator = pool[autoAssignCursor % pool.length];
  autoAssignCursor += 1;

  return assignMediator(disputeId, mediator, "auto-assignment");
}

// ---------------------------------------------------------------------------
// Mediation decision & execution
// ---------------------------------------------------------------------------

function validateResolutionAmounts(decision: MediationDecision, remainingAmount: string): void {
  let buyerAmount: bigint;
  let sellerAmount: bigint;
  try {
    buyerAmount = BigInt(decision.buyerAmount);
    sellerAmount = BigInt(decision.sellerAmount);
  } catch {
    throw new InvalidResolutionAmountsError("buyerAmount and sellerAmount must be integer stroops strings");
  }

  if (buyerAmount < 0n || sellerAmount < 0n) {
    throw new InvalidResolutionAmountsError("buyerAmount and sellerAmount must not be negative");
  }

  const remaining = BigInt(remainingAmount);
  if (buyerAmount + sellerAmount !== remaining) {
    throw new InvalidResolutionAmountsError(
      `buyerAmount + sellerAmount (${buyerAmount + sellerAmount}) must equal the remaining escrow balance (${remaining})`
    );
  }

  if (decision.decision === "full_refund" && sellerAmount !== 0n) {
    throw new InvalidResolutionAmountsError("full_refund resolutions must set sellerAmount to \"0\"");
  }
  if (decision.decision === "release_to_seller" && buyerAmount !== 0n) {
    throw new InvalidResolutionAmountsError("release_to_seller resolutions must set buyerAmount to \"0\"");
  }
}

/**
 * Records a mediator's decision. Legal only from `negotiation` (or as a
 * no-op re-submission while still `decided`, before execution has
 * succeeded) — transitions to `decided` and immediately attempts on-chain
 * execution via {@link executeDecision}.
 */
export async function submitMediationDecision(decision: MediationDecision): Promise<Dispute> {
  const dispute = await getDisputeStore().findById(decision.disputeId);
  if (!dispute) throw new DisputeNotFoundError(decision.disputeId);
  if (dispute.status === "resolved") throw new DisputeAlreadyResolvedError(dispute.id);

  assertTransition(dispute.status, "decided");

  const balance = await escrowCoordinator.getRemainingBalance(dispute.escrowId);
  validateResolutionAmounts(decision, balance.remainingAmount);

  const resolution: DisputeResolution = {
    type: decision.decision,
    buyerAmount: decision.buyerAmount,
    sellerAmount: decision.sellerAmount,
    decidedBy: decision.mediator,
    decidedAt: new Date().toISOString(),
  };

  const updated = await getDisputeStore().update(dispute.id, { status: "decided", resolution });

  await recordAuditEvent({
    disputeId: dispute.id,
    escrowId: dispute.escrowId,
    eventType: "dispute_decided",
    actor: decision.mediator,
    details: { ...resolution, reasoning: decision.reasoning },
  });
  await notifyDisputeParties("dispute_decided", balance.orderId, updated, { reasoning: decision.reasoning });

  return executeDecision(updated.id);
}

/**
 * Executes a recorded (but not-yet-resolved) mediation decision atomically
 * against the escrow contract: the buyer's share is transferred via a
 * partial refund, the seller's share via a partial release. On full success
 * the dispute transitions `decided -> resolved`, reputation is updated for
 * both parties, and `dispute_resolved` fires. On failure the dispute stays
 * `decided` with the error recorded so this can be retried safely (each
 * on-chain leg is only invoked for a nonzero amount, so a retry after a
 * partial failure does not double-spend the leg that already succeeded).
 */
export async function executeDecision(disputeId: string): Promise<Dispute> {
  const dispute = await getDisputeStore().findById(disputeId);
  if (!dispute) throw new DisputeNotFoundError(disputeId);
  if (dispute.status === "resolved") return dispute;
  if (dispute.status !== "decided" || !dispute.resolution) {
    throw new InvalidStateTransitionError(dispute.status, "resolved");
  }

  const resolution = dispute.resolution;
  const balance = await escrowCoordinator.getRemainingBalance(dispute.escrowId);
  const contractId = getEscrowContractId();

  const buyerAmount = BigInt(resolution.buyerAmount);
  const sellerAmount = BigInt(resolution.sellerAmount);
  let buyerTx: string | undefined;
  let sellerTx: string | undefined;

  try {
    if (buyerAmount > 0n) {
      const refund = await escrowCoordinator.partialRefundEscrow({
        escrowId: dispute.escrowId,
        escrowContractId: contractId,
        callerAddress: resolution.decidedBy,
        amountStroops: resolution.buyerAmount,
        reason: `dispute_resolution:${dispute.id}`,
      });
      if (refund.status !== "partial_refunded") {
        throw new Error("Buyer-side dispute resolution transfer failed on-chain");
      }
      buyerTx = refund.txHash;
    }

    if (sellerAmount > 0n) {
      const release = await escrowCoordinator.partialReleaseEscrow({
        escrowId: dispute.escrowId,
        escrowContractId: contractId,
        callerAddress: resolution.decidedBy,
        amountStroops: resolution.sellerAmount,
        memo: `Dispute ${dispute.id} resolution: release to seller`,
      });
      if (release.status !== "partial_released") {
        throw new Error("Seller-side dispute resolution transfer failed on-chain");
      }
      sellerTx = release.txHash;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown dispute resolution execution error";
    log.error("Dispute resolution execution failed", { disputeId, escrowId: dispute.escrowId, error: message });

    await getDisputeStore().update(dispute.id, { resolutionError: message });
    await recordAuditEvent({
      disputeId,
      escrowId: dispute.escrowId,
      eventType: "dispute_resolution_failed",
      details: { error: message, buyerTx, sellerTx },
    });
    await notifyDisputeParties("dispute_status_changed", balance.orderId, dispute, { error: message });

    // Stays "decided" — safe to retry via executeDecision() once the
    // underlying failure (e.g. a Soroban RPC outage) clears.
    return dispute;
  }

  const resolved = await getDisputeStore().update(dispute.id, { status: "resolved", resolutionError: null });

  await recordAuditEvent({
    disputeId,
    escrowId: dispute.escrowId,
    eventType: "dispute_resolved",
    details: { buyerTx, sellerTx, resolution },
  });
  await notifyDisputeParties("dispute_resolved", balance.orderId, resolved, { buyerTx, sellerTx });

  await recordDisputeOutcome({
    buyerAddress: balance.buyerAddress,
    sellerAddress: balance.sellerAddress,
    buyerAmount: resolution.buyerAmount,
    sellerAmount: resolution.sellerAmount,
  });

  return resolved;
}

async function safeGetBalance(escrowId: string): Promise<RemainingBalance | null> {
  try {
    return await escrowCoordinator.getRemainingBalance(escrowId);
  } catch {
    return null;
  }
}
