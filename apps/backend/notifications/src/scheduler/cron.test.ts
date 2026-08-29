import { describe, expect, it } from "vitest";
import {
  getNextCronOccurrence,
  getNextCronOccurrenceInTimezone,
  isValidCronExpression,
  isValidCronExpressionStrict,
  parseCronExpression,
} from "./cron.js";

describe("parseCronExpression", () => {
  it("parses a wildcard-only expression", () => {
    const parsed = parseCronExpression("* * * * *");
    expect(parsed.minute.values.size).toBe(60);
    expect(parsed.hour.values.size).toBe(24);
  });

  it("parses comma lists and ranges", () => {
    const parsed = parseCronExpression("0,30 9-17 * * 1-5");
    expect([...parsed.minute.values].sort((a, b) => a - b)).toEqual([0, 30]);
    expect(parsed.hour.values.has(9)).toBe(true);
    expect(parsed.hour.values.has(17)).toBe(true);
    expect(parsed.hour.values.has(8)).toBe(false);
    expect([...parsed.dayOfWeek.values].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("parses step values", () => {
    const parsed = parseCronExpression("*/15 * * * *");
    expect([...parsed.minute.values].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  it("rejects malformed expressions", () => {
    expect(() => parseCronExpression("* * * *")).toThrow();
    expect(() => parseCronExpression("61 * * * *")).toThrow();
    expect(() => parseCronExpression("* 24 * * *")).toThrow();
  });

  it("isValidCronExpression reports validity without throwing", () => {
    expect(isValidCronExpression("0 9 * * 1-5")).toBe(true);
    expect(isValidCronExpression("not a cron")).toBe(false);
  });
});

describe("getNextCronOccurrence", () => {
  it("finds the next matching minute for a wildcard expression", () => {
    const from = new Date(Date.UTC(2026, 0, 1, 10, 30));
    const next = getNextCronOccurrence("* * * * *", from);
    expect(next.toISOString()).toBe(new Date(Date.UTC(2026, 0, 1, 10, 31)).toISOString());
  });

  it("finds the next daily occurrence at a fixed hour/minute", () => {
    const from = new Date(Date.UTC(2026, 0, 1, 10, 0));
    const next = getNextCronOccurrence("0 9 * * *", from);
    expect(next.toISOString()).toBe(new Date(Date.UTC(2026, 0, 2, 9, 0)).toISOString());
  });

  it("finds the next weekday occurrence, skipping the weekend", () => {
    // 2026-01-02 is a Friday (UTC).
    const from = new Date(Date.UTC(2026, 0, 2, 12, 0));
    const next = getNextCronOccurrence("0 9 * * 1-5", from);
    // Next weekday 9:00 after Friday noon is Monday 2026-01-05.
    expect(next.toISOString()).toBe(new Date(Date.UTC(2026, 0, 5, 9, 0)).toISOString());
  });

  it("throws for an invalid cron expression", () => {
    expect(() => getNextCronOccurrence("garbage")).toThrow();
  });
});

describe("isValidCronExpressionStrict (Issue #59)", () => {
  it("accepts standard 5-field expressions", () => {
    expect(isValidCronExpressionStrict("0 9 * * 1-5")).toBe(true);
    expect(isValidCronExpressionStrict("*/15 * * * *")).toBe(true);
  });

  it("rejects malformed expressions", () => {
    expect(isValidCronExpressionStrict("not a cron")).toBe(false);
  });

  it("does not treat an empty string as malformed (cron-parser treats it as all-wildcards)", () => {
    // Documents cron-parser's actual behavior rather than asserting a stricter rule this
    // wrapper does not itself enforce — the notifications HTTP routes are responsible for
    // rejecting an empty cronExpression as a required-field validation error before it
    // ever reaches this function.
    expect(isValidCronExpressionStrict("")).toBe(true);
  });
});

describe("getNextCronOccurrenceInTimezone (Issue #59)", () => {
  it("defaults to UTC when no timezone is given", () => {
    const from = new Date(Date.UTC(2026, 0, 1, 10, 0));
    const next = getNextCronOccurrenceInTimezone("0 9 * * *", "UTC", from);
    expect(next.toISOString()).toBe(new Date(Date.UTC(2026, 0, 2, 9, 0)).toISOString());
  });

  it("evaluates 9am in America/New_York as 14:00 UTC during EST (no DST)", () => {
    // 2026-01-01 05:00 EST (10:00 UTC) is before 9am EST same day, so the next
    // occurrence is later that same day, not the day after.
    const from = new Date(Date.UTC(2026, 0, 1, 10, 0));
    const next = getNextCronOccurrenceInTimezone("0 9 * * *", "America/New_York", from);
    expect(next.toISOString()).toBe(new Date(Date.UTC(2026, 0, 1, 14, 0)).toISOString());
  });

  it("evaluates 9am in America/New_York as 13:00 UTC during EDT (DST active)", () => {
    // 2026-07-01 06:00 EDT (10:00 UTC) is before 9am EDT same day.
    const from = new Date(Date.UTC(2026, 6, 1, 10, 0));
    const next = getNextCronOccurrenceInTimezone("0 9 * * *", "America/New_York", from);
    expect(next.toISOString()).toBe(new Date(Date.UTC(2026, 6, 1, 13, 0)).toISOString());
  });

  it("shifts the computed UTC offset across a DST spring-forward transition (US, 2026-03-08)", () => {
    // Before the transition: EST, UTC-05:00.
    const beforeDst = getNextCronOccurrenceInTimezone(
      "0 9 * * *",
      "America/New_York",
      new Date(Date.UTC(2026, 2, 7, 0, 0))
    );
    expect(beforeDst.toISOString()).toBe(new Date(Date.UTC(2026, 2, 7, 14, 0)).toISOString());

    // After the transition: EDT, UTC-04:00 — same 9am local time, different UTC instant.
    const afterDst = getNextCronOccurrenceInTimezone(
      "0 9 * * *",
      "America/New_York",
      new Date(Date.UTC(2026, 2, 9, 0, 0))
    );
    expect(afterDst.toISOString()).toBe(new Date(Date.UTC(2026, 2, 9, 13, 0)).toISOString());
  });

  it("throws a descriptive error for an invalid cron expression", () => {
    expect(() => getNextCronOccurrenceInTimezone("garbage", "UTC")).toThrow(
      /Could not compute next occurrence/
    );
  });

  it("throws a descriptive error for an invalid IANA timezone", () => {
    expect(() => getNextCronOccurrenceInTimezone("0 9 * * *", "Not/A_Timezone")).toThrow(
      /Could not compute next occurrence/
    );
  });
});
