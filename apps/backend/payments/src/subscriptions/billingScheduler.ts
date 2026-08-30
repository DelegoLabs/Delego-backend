/**
 * Background billing cycle for subscriptions (Issue #47).
 *
 * Each pass:
 *   1. Renews (charges + advances the period for) every `active`/`past_due`/
 *      `trialing` subscription whose `currentPeriodEnd` has passed.
 *   2. Finalizes cancellation for subscriptions flagged `cancelAtPeriodEnd`
 *      whose period has now ended.
 *
 * Both steps are idempotent per period (see `chargeStore.ts`), so re-running
 * a pass — or overlapping passes — never double-bills a subscription.
 */

import { createLogger } from "@delegolabs/utils";
import { getSubscriptionStore } from "./subscriptionStore.js";
import { renewSubscription } from "./service.js";
import { emitSubscriptionEvent, subscriptionEvent } from "./notifications.js";
import type { Subscription, SubscriptionStatus } from "./types.js";

const log = createLogger("payments:subscriptions:scheduler", process.env.LOG_LEVEL ?? "info");

const DUE_STATUSES: SubscriptionStatus[] = ["active", "past_due", "trialing"];

export interface BillingCycleResult {
  renewed: Subscription[];
  failed: Subscription[];
  cancelled: Subscription[];
}

export async function runBillingCycle(now: Date = new Date()): Promise<BillingCycleResult> {
  const store = getSubscriptionStore();
  const result: BillingCycleResult = { renewed: [], failed: [], cancelled: [] };

  const due = await store.findDue(now, DUE_STATUSES);
  for (const subscription of due) {
    // A subscription already flagged to cancel at period end shouldn't be
    // billed for another cycle — it's handled by the cancellation pass below.
    if (subscription.cancelAtPeriodEnd) continue;

    try {
      const updated = await renewSubscription(subscription.id, { force: true });
      if (updated.status === "past_due") {
        result.failed.push(updated);
      } else {
        result.renewed.push(updated);
      }
    } catch (err) {
      log.error("Failed to renew subscription during billing cycle", {
        subscriptionId: subscription.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const pendingCancellation = await store.findPendingCancellation(now);
  for (const subscription of pendingCancellation) {
    try {
      const cancelled = await store.update(subscription.id, { status: "cancelled" });
      await emitSubscriptionEvent(subscriptionEvent(subscription.id, "cancelled", { immediate: false }));
      result.cancelled.push(cancelled);
    } catch (err) {
      log.error("Failed to finalize scheduled cancellation", {
        subscriptionId: subscription.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("Billing cycle completed", {
    scanned: due.length,
    renewed: result.renewed.length,
    failed: result.failed.length,
    cancelled: result.cancelled.length,
  });

  return result;
}

/** Mirrors the settlement reconciler / dispute SLA scheduler shape — returns a stop function. */
export function startSubscriptionBillingScheduler(): () => void {
  const intervalSeconds = Number(process.env.SUBSCRIPTION_BILLING_INTERVAL_SECONDS ?? 3600);
  const intervalMs = intervalSeconds * 1000;

  const intervalId = setInterval(() => {
    runBillingCycle().catch((err) => {
      log.error("Unhandled error in subscription billing scheduler", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs);

  log.info("Subscription billing scheduler started", { intervalSeconds });

  return () => {
    clearInterval(intervalId);
    log.info("Subscription billing scheduler stopped");
  };
}
