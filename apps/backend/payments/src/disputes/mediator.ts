/**
 * Automated Dispute Mediation & Rule-Based Arbitration Engine (Issue #296)
 *
 * A rule engine that settles straightforward disputes automatically based on
 * carrier tracking status and merchant counter-offer responses, escalating to
 * human arbitration when evidence is ambiguous.
 *
 * Scope: apps/backend/payments/src/disputes/mediator.ts
 */

import { createLogger } from "@delegolabs/utils";
import { getDisputeStore } from "./disputeStore.js";
import { escrowCoordinator } from "../escrowCoordinator/index.js";
import { getEscrowContractId } from "../../escrow/config.js";
import { autoAssignMediator, submitMediationDecision } from "./mediation.js";
import { recordAuditEvent } from "./auditLog.js";
import {
  DisputeNotFoundError,
  type Dispute,
  type DisputeEvidenceEntry,
  type MediationDecision,
} from "./types.js";

const log = createLogger("payments:disputes:mediator", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DisputeMediationDecision {
  disputeId: string;
  verdict: "refund_buyer" | "payout_merchant" | "escalate_human";
  /** Confidence in the automated verdict: 0.0 – 1.0 */
  confidence: number;
  reasoning: string;
}

export interface CarrierTrackingInfo {
  status: string;
  /** Canonical carrier status codes used by the rule engine. */
  carrierStatus:
    | "delivered"
    | "return_to_sender"
    | "in_transit"
    | "out_for_delivery"
    | "failed_delivery"
    | "unknown";
  updatedAt?: string;
}

export interface PartialRefundOffer {
  /** Refund amount accepted by the merchant, in stroops. */
  amountStroops: string;
  acceptedBy: string;
  acceptedAt: string;
}

export interface AutoMediationInput {
  disputeId: string;
  /** Live carrier tracking data from the delivery oracle. */
  tracking?: CarrierTrackingInfo;
  /** Merchant's accepted partial refund offer, if any. */
  partialRefundOffer?: PartialRefundOffer;
}

// ---------------------------------------------------------------------------
// Confidence thresholds
// ---------------------------------------------------------------------------

/**
 * Minimum confidence required to auto-execute a verdict without human review.
 * Disputes whose confidence falls below this threshold are escalated.
 */
const AUTO_EXECUTE_CONFIDENCE_THRESHOLD = parseFloat(
  process.env.DISPUTE_AUTO_EXECUTE_CONFIDENCE ?? "0.8"
);

// ---------------------------------------------------------------------------
// Rule engine
// ---------------------------------------------------------------------------

/**
 * Evaluates dispute rules and returns a `DisputeMediationDecision`.
 *
 * Rules (evaluated in priority order):
 *
 * 1. Carrier status == `return_to_sender`
 *    → auto-refund buyer (confidence: 0.95)
 *
 * 2. Carrier status == `delivered`
 *    → auto-payout merchant (confidence: 0.90)
 *
 * 3. Merchant accepted a partial refund offer
 *    → execute the split release agreed upon (confidence: 0.85)
 *
 * 4. Carrier status == `failed_delivery`
 *    → refund buyer (confidence: 0.80)
 *
 * 5. Evidence is ambiguous or carrier status is `unknown`/`in_transit`
 *    → escalate to human arbitration (confidence: 1.0 — we're certain
 *       we cannot decide automatically)
 */
export function evaluateDisputeRules(
  dispute: Dispute,
  tracking?: CarrierTrackingInfo,
  partialRefundOffer?: PartialRefundOffer
): DisputeMediationDecision {
  const disputeId = dispute.id;

  // Rule 1: Return to sender — buyer should be refunded
  if (tracking?.carrierStatus === "return_to_sender") {
    return {
      disputeId,
      verdict: "refund_buyer",
      confidence: 0.95,
      reasoning:
        "Carrier tracking confirms the package was returned to sender. " +
        "Buyer is entitled to a full refund per return-to-sender policy.",
    };
  }

  // Rule 2: Confirmed delivery — merchant should receive funds
  if (tracking?.carrierStatus === "delivered") {
    return {
      disputeId,
      verdict: "payout_merchant",
      confidence: 0.9,
      reasoning:
        "Carrier tracking confirms the package was delivered successfully. " +
        "Funds will be released to the merchant.",
    };
  }

  // Rule 3: Merchant accepted a partial refund offer — execute the split
  if (partialRefundOffer) {
    return {
      disputeId,
      verdict: "refund_buyer",
      confidence: 0.85,
      reasoning:
        `Merchant accepted a partial refund offer of ${partialRefundOffer.amountStroops} stroops. ` +
        "The agreed partial refund will be executed and remaining funds released to the merchant.",
    };
  }

  // Rule 4: Failed delivery attempt — refund buyer
  if (tracking?.carrierStatus === "failed_delivery") {
    return {
      disputeId,
      verdict: "refund_buyer",
      confidence: 0.8,
      reasoning:
        "Carrier tracking indicates a failed delivery attempt. " +
        "Buyer will be refunded as the item was not delivered.",
    };
  }

  // Examine evidence content for any clear signals
  const evidenceSignals = analyzeEvidence(dispute.evidence);
  if (evidenceSignals) {
    return { disputeId, ...evidenceSignals };
  }

  // Rule 5: Ambiguous — escalate to human
  const reason =
    tracking
      ? `Carrier status is "${tracking.carrierStatus}" — insufficient evidence for automated resolution.`
      : "No carrier tracking data available and evidence is ambiguous.";

  return {
    disputeId,
    verdict: "escalate_human",
    confidence: 1.0,
    reasoning: reason,
  };
}

/**
 * Scans evidence entries for keywords that indicate a clear resolution path.
 * Returns a partial DisputeMediationDecision (without disputeId) or null.
 */
function analyzeEvidence(
  evidence: DisputeEvidenceEntry[]
): Omit<DisputeMediationDecision, "disputeId"> | null {
  const allText = evidence
    .map((e) => `${e.description}`.toLowerCase())
    .join(" ");

  // Strong buyer-favour signals
  if (
    allText.includes("returned to sender") ||
    allText.includes("return to sender") ||
    allText.includes("not received") ||
    allText.includes("package lost")
  ) {
    return {
      verdict: "refund_buyer",
      confidence: 0.75,
      reasoning:
        "Evidence descriptions contain clear indicators that goods were not received " +
        "or were returned. Refunding buyer based on evidence analysis.",
    };
  }

  // Strong merchant-favour signals
  if (
    allText.includes("proof of delivery") ||
    allText.includes("signed for") ||
    allText.includes("delivered successfully") ||
    allText.includes("confirmed delivery")
  ) {
    return {
      verdict: "payout_merchant",
      confidence: 0.75,
      reasoning:
        "Evidence contains proof-of-delivery indicators. Releasing funds to merchant " +
        "based on evidence analysis.",
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Auto-mediation execution
// ---------------------------------------------------------------------------

/**
 * Runs the rule engine on a dispute and, if confidence exceeds the threshold,
 * automatically executes the verdict via the existing mediation pipeline.
 * Otherwise escalates to human arbitration via `autoAssignMediator`.
 *
 * Returns the resulting `DisputeMediationDecision`.
 */
export async function runAutoMediation(input: AutoMediationInput): Promise<DisputeMediationDecision> {
  const store = getDisputeStore();
  const dispute = await store.findById(input.disputeId);
  if (!dispute) throw new DisputeNotFoundError(input.disputeId);

  // Skip already-resolved disputes
  if (dispute.status === "resolved" || dispute.status === "decided") {
    log.info("Dispute already decided/resolved; skipping auto-mediation", {
      disputeId: input.disputeId,
      status: dispute.status,
    });
    return {
      disputeId: input.disputeId,
      verdict: "escalate_human",
      confidence: 1.0,
      reasoning: `Dispute is already in status "${dispute.status}"; no auto-mediation needed.`,
    };
  }

  const decision = evaluateDisputeRules(dispute, input.tracking, input.partialRefundOffer);

  await recordAuditEvent({
    disputeId: dispute.id,
    escrowId: dispute.escrowId,
    eventType: "dispute_auto_mediation_evaluated",
    details: { decision },
  });

  log.info("Auto-mediation rule evaluation complete", {
    disputeId: dispute.id,
    verdict: decision.verdict,
    confidence: decision.confidence,
  });

  // Escalate if confidence is below threshold or verdict is human escalation
  if (
    decision.verdict === "escalate_human" ||
    decision.confidence < AUTO_EXECUTE_CONFIDENCE_THRESHOLD
  ) {
    log.info("Escalating dispute to human arbitration", {
      disputeId: dispute.id,
      reason: decision.reasoning,
      confidence: decision.confidence,
    });

    try {
      await autoAssignMediator(dispute.id);
    } catch (err) {
      // Pool may not be configured in dev — log but don't fail the decision
      const message = err instanceof Error ? err.message : String(err);
      log.warn("Auto-assign mediator failed during escalation", {
        disputeId: dispute.id,
        error: message,
      });
    }

    await recordAuditEvent({
      disputeId: dispute.id,
      escrowId: dispute.escrowId,
      eventType: "dispute_escalated_to_human",
      details: { reasoning: decision.reasoning, confidence: decision.confidence },
    });

    return decision;
  }

  // Execute the automated verdict
  await executeAutomatedVerdict(dispute, decision, input.partialRefundOffer);
  return decision;
}

/**
 * Translates a high-confidence automated verdict into a `MediationDecision`
 * and submits it through the standard mediation pipeline so the same
 * on-chain execution and audit trail applies.
 */
async function executeAutomatedVerdict(
  dispute: Dispute,
  decision: DisputeMediationDecision,
  partialRefundOffer?: PartialRefundOffer
): Promise<void> {
  const balance = await escrowCoordinator.getRemainingBalance(dispute.escrowId);
  const remaining = balance.remainingAmount;
  const contractId = getEscrowContractId();

  let mediationDecision: MediationDecision;

  if (decision.verdict === "refund_buyer") {
    if (partialRefundOffer) {
      // Split: merchant accepted partial refund — buyer gets the partial amount,
      // merchant gets the rest.
      const refundAmount = partialRefundOffer.amountStroops;
      const refundBig = BigInt(refundAmount);
      const remainingBig = BigInt(remaining);
      const sellerAmount = (remainingBig - refundBig).toString();

      mediationDecision = {
        disputeId: dispute.id,
        decision: "partial_refund",
        buyerAmount: refundAmount,
        sellerAmount,
        reasoning: decision.reasoning,
        mediator: "auto-mediator",
      };
    } else {
      // Full refund to buyer
      mediationDecision = {
        disputeId: dispute.id,
        decision: "full_refund",
        buyerAmount: remaining,
        sellerAmount: "0",
        reasoning: decision.reasoning,
        mediator: "auto-mediator",
      };
    }
  } else {
    // payout_merchant — full release to seller
    mediationDecision = {
      disputeId: dispute.id,
      decision: "release_to_seller",
      buyerAmount: "0",
      sellerAmount: remaining,
      reasoning: decision.reasoning,
      mediator: "auto-mediator",
    };
  }

  try {
    await submitMediationDecision(mediationDecision);
    log.info("Automated mediation decision submitted", {
      disputeId: dispute.id,
      verdict: decision.verdict,
      contractId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Failed to execute automated mediation decision", {
      disputeId: dispute.id,
      error: message,
    });
    await recordAuditEvent({
      disputeId: dispute.id,
      escrowId: dispute.escrowId,
      eventType: "dispute_auto_mediation_failed",
      details: { error: message, decision },
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Batch auto-mediation sweep
// ---------------------------------------------------------------------------

/**
 * Sweeps all open disputes and runs auto-mediation for those that have
 * carrier tracking data or have been in `evidence_collection` long enough.
 * Designed to be called by a cron job or the payments startup routine.
 *
 * Returns the number of disputes processed and those escalated.
 */
export async function sweepAutoMediation(
  fetchTracking?: (escrowId: string) => Promise<CarrierTrackingInfo | undefined>
): Promise<{ processed: number; escalated: number; resolved: number }> {
  const store = getDisputeStore();
  // findBreached returns disputes whose SLA has passed — these need urgent attention
  const breached = await store.findBreached(new Date());

  let processed = 0;
  let escalated = 0;
  let resolved = 0;

  for (const dispute of breached) {
    try {
      const tracking = fetchTracking ? await fetchTracking(dispute.escrowId) : undefined;
      const result = await runAutoMediation({ disputeId: dispute.id, tracking });
      processed += 1;

      if (result.verdict === "escalate_human") {
        escalated += 1;
      } else {
        resolved += 1;
      }
    } catch (err) {
      log.error("Auto-mediation sweep failed for dispute", {
        disputeId: dispute.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("Auto-mediation sweep complete", { processed, escalated, resolved });
  return { processed, escalated, resolved };
}
