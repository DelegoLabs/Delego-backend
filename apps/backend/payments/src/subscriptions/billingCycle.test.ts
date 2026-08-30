import { describe, expect, it } from "vitest";
import { addBillingInterval, computeInitialPeriod } from "./billingCycle.js";

describe("addBillingInterval", () => {
  it("advances by whole days", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    expect(addBillingInterval(start, "day", 1).toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(addBillingInterval(start, "day", 7).toISOString()).toBe("2026-01-08T00:00:00.000Z");
  });

  it("advances by whole weeks", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    expect(addBillingInterval(start, "week", 1).toISOString()).toBe("2026-01-08T00:00:00.000Z");
    expect(addBillingInterval(start, "week", 2).toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });

  it("advances by calendar months, preserving the day-of-month where possible", () => {
    const start = new Date("2026-01-15T00:00:00.000Z");
    expect(addBillingInterval(start, "month", 1).toISOString()).toBe("2026-02-15T00:00:00.000Z");
    expect(addBillingInterval(start, "month", 3).toISOString()).toBe("2026-04-15T00:00:00.000Z");
  });

  it("clamps to the last day of a shorter month instead of overflowing", () => {
    const jan31 = new Date("2026-01-31T00:00:00.000Z");
    // 2026 is not a leap year — Feb has 28 days.
    expect(addBillingInterval(jan31, "month", 1).toISOString()).toBe("2026-02-28T00:00:00.000Z");
  });

  it("advances by whole years, handling leap-day anchors", () => {
    const leapDay = new Date("2024-02-29T00:00:00.000Z");
    expect(addBillingInterval(leapDay, "year", 1).toISOString()).toBe("2025-02-28T00:00:00.000Z");
    expect(addBillingInterval(leapDay, "year", 4).toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("rejects a non-positive intervalCount", () => {
    expect(() => addBillingInterval(new Date(), "day", 0)).toThrow();
    expect(() => addBillingInterval(new Date(), "day", -1)).toThrow();
  });
});

describe("computeInitialPeriod", () => {
  it("starts a trial period ending at start + trialDays when trialDays > 0", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const { periodStart, periodEnd, trialEnd } = computeInitialPeriod(start, "month", 1, 14);

    expect(periodStart.toISOString()).toBe(start.toISOString());
    expect(periodEnd.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(trialEnd?.toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });

  it("starts a full billing period immediately when there is no trial", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const { periodStart, periodEnd, trialEnd } = computeInitialPeriod(start, "month", 1, undefined);

    expect(periodStart.toISOString()).toBe(start.toISOString());
    expect(periodEnd.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(trialEnd).toBeUndefined();
  });

  it("treats trialDays: 0 the same as no trial", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const { trialEnd } = computeInitialPeriod(start, "week", 1, 0);
    expect(trialEnd).toBeUndefined();
  });
});
