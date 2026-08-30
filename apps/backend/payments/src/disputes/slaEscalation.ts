/**
 * SLA breach detection & auto-escalation for open disputes (Issue #46).
 *
 * Every dispute gets a 14-day `slaDeadline` on open (see
 * {@link DEFAULT_SLA_DAYS} in `mediation.ts`). A periodic scan finds
 * disputes that are still active (not `decided`/`resolved`) past that
 * deadline and escalates them — marking `escalated_at`, auditing the event,
 * and notifying so mediator attention (or an admin fallback) can pick it up.
 */

import { createLogger } from "@delegolabs/utils";
import { escrowCoordinator } from "../escrowCoordinator/index.js";
import { recordAuditEvent } from "./auditLog.js";
import { getDisputeStore } from "./disputeStore.js";
import { notifyDisputeParties } from "./notifications.js";
import type { Dispute } from "./types.js";

const log = createLogger("payments:disputes:sla", process.env.LOG_LEVEL ?? "info");

export interface SlaEscalationResult {
  scanned: number;
  escalated: Dispute[];
}

/**
 * Finds and escalates every open dispute whose SLA deadline has passed.
 * Idempotent: a dispute is only escalated once (`escalated_at` gates it out
 * of future scans), so calling this repeatedly (e.g. from a cron tick) is
 * always safe.
 */
export async function findAndEscalateBreachedDisputes(now: Date = new Date()): Promise<SlaEscalationResult> {
  const store = getDisputeStore();
  const breached = await store.findBreached(now);

  const escalated: Dispute[] = [];
  for (const dispute of breached) {
    try {
      const escalatedAt = now.toISOString();
      const updated = await store.update(dispute.id, { escalatedAt });

      await recordAuditEvent({
        disputeId: dispute.id,
        escrowId: dispute.escrowId,
        eventType: "dispute_sla_breached",
        details: { slaDeadline: dispute.slaDeadline, escalatedAt, mediator: dispute.mediator },
      });

      const orderId = await safeGetOrderId(dispute.escrowId);
      if (orderId) {
        await notifyDisputeParties("dispute_sla_breached", orderId, updated, {
          slaDeadline: dispute.slaDeadline,
        });
      }

      log.warn("Dispute SLA breached; escalated", {
        disputeId: dispute.id,
        escrowId: dispute.escrowId,
        slaDeadline: dispute.slaDeadline,
        mediator: dispute.mediator,
      });
      escalated.push(updated);
    } catch (err) {
      log.error("Failed to escalate breached dispute", {
        disputeId: dispute.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { scanned: breached.length, escalated };
}

async function safeGetOrderId(escrowId: string): Promise<string | null> {
  try {
    const balance = await escrowCoordinator.getRemainingBalance(escrowId);
    return balance.orderId;
  } catch {
    return null;
  }
}

/**
 * Starts a periodic SLA-breach scan (default every hour; configurable via
 * `DISPUTE_SLA_SCAN_INTERVAL_SECONDS`). Mirrors the settlement reconciler's
 * scheduler shape — returns a stop function for graceful shutdown.
 */
export function startSlaEscalationScheduler(): () => void {
  const intervalSeconds = Number(process.env.DISPUTE_SLA_SCAN_INTERVAL_SECONDS ?? 3600);
  const intervalMs = intervalSeconds * 1000;

  const intervalId = setInterval(() => {
    findAndEscalateBreachedDisputes().catch((err) => {
      log.error("Unhandled error in SLA escalation scheduler", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs);

  log.info("Dispute SLA escalation scheduler started", { intervalSeconds });

  return () => {
    clearInterval(intervalId);
    log.info("Dispute SLA escalation scheduler stopped");
  };
}
