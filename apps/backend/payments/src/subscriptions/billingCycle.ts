/**
 * Billing-period arithmetic for recurring subscriptions (Issue #47).
 *
 * `day`/`week` intervals are fixed-duration and drift-free. `month`/`year`
 * intervals use calendar arithmetic (`setUTCMonth`/`setUTCFullYear`) so a
 * plan billed "monthly" actually lands on (close to) the same day each
 * month rather than a fixed 30-day approximation. When a month is too
 * short for the anchor day (e.g. Jan 31 -> Feb), the period end clamps to
 * that month's last day — which becomes the new anchor for the *next*
 * period, so the day-of-month can drift after crossing a short month
 * (Jan 31 -> Feb 28 -> Mar 28, not Mar 31). This chained-anchor tradeoff is
 * the standard simplification most non-calendar-library billing systems
 * make; period boundaries are always well-defined and monotonically
 * increasing either way.
 */

import type { BillingInterval } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Advances `start` by one billing period (`intervalCount` units of `interval`). */
export function addBillingInterval(start: Date, interval: BillingInterval, intervalCount: number): Date {
  if (intervalCount <= 0) {
    throw new Error("intervalCount must be a positive integer");
  }

  if (interval === "day") {
    return new Date(start.getTime() + intervalCount * DAY_MS);
  }
  if (interval === "week") {
    return new Date(start.getTime() + intervalCount * WEEK_MS);
  }

  const result = new Date(start.getTime());
  const anchorDay = result.getUTCDate();

  if (interval === "month") {
    result.setUTCMonth(result.getUTCMonth() + intervalCount);
  } else {
    result.setUTCFullYear(result.getUTCFullYear() + intervalCount);
  }

  // If the target month is shorter than the anchor day (e.g. 31st into
  // February), setUTCMonth/FullYear overflows into the following month —
  // clamp back to the last day of the intended month instead.
  if (result.getUTCDate() !== anchorDay) {
    result.setUTCDate(0);
  }

  return result;
}

/** Computes the first period's [start, end) given a plan's interval and an optional trial. */
export function computeInitialPeriod(
  start: Date,
  interval: BillingInterval,
  intervalCount: number,
  trialDays?: number
): { periodStart: Date; periodEnd: Date; trialEnd?: Date } {
  if (trialDays && trialDays > 0) {
    const trialEnd = new Date(start.getTime() + trialDays * DAY_MS);
    return { periodStart: start, periodEnd: trialEnd, trialEnd };
  }

  return { periodStart: start, periodEnd: addBillingInterval(start, interval, intervalCount) };
}
