/**
 * Recurring Payment Subscriptions with Escrow — core service (Issue #47).
 */

import { createLogger } from "@delegolabs/utils";
import { addBillingInterval, computeInitialPeriod } from "./billingCycle.js";
import { chargeSubscriptionPeriod } from "./billing.js";
import { getPlanStore } from "./planStore.js";
import { getSubscriptionStore } from "./subscriptionStore.js";
import { emitSubscriptionEvent, subscriptionEvent } from "./notifications.js";
import {
  SubscriptionNotActiveError,
  SubscriptionNotFoundError,
  SubscriptionPlanNotFoundError,
  type CreateSubscriptionInput,
  type CreateSubscriptionPlanInput,
  type RenewSubscriptionOptions,
  type Subscription,
  type SubscriptionPlan,
} from "./types.js";

const log = createLogger("payments:subscriptions", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export async function createSubscriptionPlan(input: CreateSubscriptionPlanInput): Promise<SubscriptionPlan> {
  return getPlanStore().create(input);
}

export async function getSubscriptionPlan(planId: string): Promise<SubscriptionPlan> {
  const plan = await getPlanStore().findById(planId);
  if (!plan) throw new SubscriptionPlanNotFoundError(planId);
  return plan;
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export async function getSubscription(subscriptionId: string): Promise<Subscription> {
  const sub = await getSubscriptionStore().findById(subscriptionId);
  if (!sub) throw new SubscriptionNotFoundError(subscriptionId);
  return sub;
}

/**
 * Creates a subscription. Plans with `trialDays > 0` (and no override to
 * skip it) start `trialing` with no charge; otherwise the first period is
 * charged immediately — a failed first charge still creates the
 * subscription, just in `past_due` rather than `active`, so the buyer can
 * retry payment without re-subscribing.
 */
export async function createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
  const plan = await getSubscriptionPlan(input.planId);
  const now = new Date();
  const trialDays = input.trialDaysOverride ?? plan.trialDays;
  const { periodStart, periodEnd, trialEnd } = computeInitialPeriod(now, plan.interval, plan.intervalCount, trialDays);

  const isTrialing = Boolean(trialEnd);
  let subscription = await getSubscriptionStore().create({
    ...input,
    status: isTrialing ? "trialing" : "active",
    currentPeriodStart: periodStart.toISOString(),
    currentPeriodEnd: periodEnd.toISOString(),
    trialEnd: trialEnd?.toISOString(),
  });

  await emitSubscriptionEvent(subscriptionEvent(subscription.id, "created", { planId: plan.id, trialing: isTrialing }));

  if (!isTrialing) {
    const charge = await chargeSubscriptionPeriod(subscription, plan, periodStart.toISOString(), periodEnd.toISOString(), plan.amount);
    if (charge.status !== "succeeded") {
      subscription = await getSubscriptionStore().update(subscription.id, { status: "past_due" });
      await emitSubscriptionEvent(
        subscriptionEvent(subscription.id, "payment_failed", { reason: charge.failureReason, periodStart: periodStart.toISOString() })
      );
    }
  }

  return subscription;
}

/**
 * Charges the current period and advances the subscription to the next one.
 * By default only proceeds if `currentPeriodEnd` has actually passed (or
 * the subscription is `trialing` and its trial has ended) — pass
 * `force: true` to bypass that (used by explicit/manual renewal requests).
 */
export async function renewSubscription(
  subscriptionId: string,
  options: RenewSubscriptionOptions = {}
): Promise<Subscription> {
  const subscription = await getSubscription(subscriptionId);
  const plan = await getSubscriptionPlan(subscription.planId);

  if (subscription.status !== "active" && subscription.status !== "past_due" && subscription.status !== "trialing") {
    throw new SubscriptionNotActiveError(subscriptionId, subscription.status);
  }

  const now = new Date();
  if (!options.force && new Date(subscription.currentPeriodEnd).getTime() > now.getTime()) {
    // Not due yet — return unchanged rather than charging early.
    return subscription;
  }

  const amount = resolveChargeAmount(plan, options.usageAmount);
  const periodStart = subscription.currentPeriodEnd;
  const periodEnd = addBillingInterval(new Date(periodStart), plan.interval, plan.intervalCount).toISOString();

  const charge = await chargeSubscriptionPeriod(subscription, plan, periodStart, periodEnd, amount);

  if (charge.status !== "succeeded") {
    const failed = await getSubscriptionStore().update(subscriptionId, { status: "past_due" });
    await emitSubscriptionEvent(
      subscriptionEvent(subscriptionId, "payment_failed", { reason: charge.failureReason, periodStart })
    );
    return failed;
  }

  const renewed = await getSubscriptionStore().update(subscriptionId, {
    status: "active",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    trialEnd: null,
  });
  await emitSubscriptionEvent(
    subscriptionEvent(subscriptionId, "renewed", { periodStart, periodEnd, amount, txHash: charge.releaseTxHash })
  );
  return renewed;
}

function resolveChargeAmount(plan: SubscriptionPlan, usageAmount?: string): string {
  if (!plan.usageBased || usageAmount === undefined) {
    return plan.amount;
  }
  if (plan.maxAmount !== undefined && BigInt(usageAmount) > BigInt(plan.maxAmount)) {
    return plan.maxAmount;
  }
  return usageAmount;
}

export async function pauseSubscription(subscriptionId: string): Promise<Subscription> {
  const subscription = await getSubscription(subscriptionId);
  if (subscription.status === "cancelled") {
    throw new SubscriptionNotActiveError(subscriptionId, subscription.status);
  }

  const updated = await getSubscriptionStore().update(subscriptionId, { status: "paused" });
  await emitSubscriptionEvent(subscriptionEvent(subscriptionId, "paused", {}));
  return updated;
}

/**
 * Resumes a paused subscription. Billing continues from the existing
 * `currentPeriodEnd` — a resumed subscription doesn't get a fresh period
 * for the time it spent paused, so it will likely renew (and be charged)
 * on its very next scheduler pass if the pause outlasted the period.
 */
export async function resumeSubscription(subscriptionId: string): Promise<Subscription> {
  const subscription = await getSubscription(subscriptionId);
  if (subscription.status !== "paused") {
    throw new SubscriptionNotActiveError(subscriptionId, subscription.status);
  }

  return getSubscriptionStore().update(subscriptionId, { status: "active" });
}

export interface CancelSubscriptionOptions {
  atPeriodEnd?: boolean;
}

export async function cancelSubscription(
  subscriptionId: string,
  options: CancelSubscriptionOptions = {}
): Promise<Subscription> {
  const subscription = await getSubscription(subscriptionId);
  if (subscription.status === "cancelled") {
    return subscription;
  }

  if (options.atPeriodEnd) {
    log.info("Subscription flagged to cancel at period end", { subscriptionId });
    return getSubscriptionStore().update(subscriptionId, { cancelAtPeriodEnd: true });
  }

  const cancelled = await getSubscriptionStore().update(subscriptionId, {
    status: "cancelled",
    cancelAtPeriodEnd: false,
  });
  await emitSubscriptionEvent(subscriptionEvent(subscriptionId, "cancelled", { immediate: true }));
  return cancelled;
}

/**
 * Switches a subscription to a different plan. Takes effect starting the
 * *next* billing cycle — the current period, already paid for under the
 * old plan, runs to its existing end date unchanged.
 */
export async function changeSubscriptionPlan(subscriptionId: string, newPlanId: string): Promise<Subscription> {
  const subscription = await getSubscription(subscriptionId);
  const oldPlanId = subscription.planId;
  await getSubscriptionPlan(newPlanId); // throws SubscriptionPlanNotFoundError if invalid

  const updated = await getSubscriptionStore().update(subscriptionId, { planId: newPlanId });
  await emitSubscriptionEvent(subscriptionEvent(subscriptionId, "plan_changed", { oldPlanId, newPlanId }));
  return updated;
}
