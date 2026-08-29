/**
 * Minimal 5-field cron expression evaluator (Issue #365).
 *
 * Supports the standard `minute hour day-of-month month day-of-week` format
 * with `*`, single values, comma lists, ranges (`a-b`), and step values
 * (star-slash-n, `a-b/n`). No external dependency required.
 *
 * This evaluator is UTC-only by design (see getNextCronOccurrence below) —
 * for timezone-aware / DST-aware scheduling (Issue #59), see
 * getNextCronOccurrenceInTimezone, which delegates to the `cron-parser` +
 * `luxon` libraries instead of extending this hand-rolled evaluator with
 * IANA timezone/DST rules, which are not something to reimplement.
 */
import { CronExpressionParser } from "cron-parser";

export interface CronField {
  values: Set<number>;
}

const FIELD_RANGES: Array<{ min: number; max: number }> = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week (0 = Sunday)
];

function parseField(raw: string, min: number, max: number): CronField {
  const values = new Set<number>();

  for (const part of raw.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? parseInt(stepPart, 10) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Invalid cron step: "${part}"`);
    }

    let rangeStart = min;
    let rangeEnd = max;

    if (rangePart !== "*") {
      if (rangePart.includes("-")) {
        const [startStr, endStr] = rangePart.split("-");
        rangeStart = parseInt(startStr, 10);
        rangeEnd = parseInt(endStr, 10);
      } else {
        rangeStart = parseInt(rangePart, 10);
        rangeEnd = rangeStart;
      }
    }

    if (
      !Number.isInteger(rangeStart) ||
      !Number.isInteger(rangeEnd) ||
      rangeStart < min ||
      rangeEnd > max ||
      rangeStart > rangeEnd
    ) {
      throw new Error(`Invalid cron field value: "${part}" (expected ${min}-${max})`);
    }

    for (let v = rangeStart; v <= rangeEnd; v += step) {
      values.add(v);
    }
  }

  return { values };
}

export interface ParsedCronExpression {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

export function parseCronExpression(expression: string): ParsedCronExpression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Invalid cron expression: "${expression}" — expected 5 fields (minute hour day-of-month month day-of-week)`
    );
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((field, i) =>
    parseField(field, FIELD_RANGES[i].min, FIELD_RANGES[i].max)
  );

  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

/** Validate a cron expression without needing the parsed result. */
export function isValidCronExpression(expression: string): boolean {
  try {
    parseCronExpression(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the next UTC Date matching the cron expression, strictly after `from`.
 * Searches minute-by-minute up to two years ahead before giving up.
 */
export function getNextCronOccurrence(expression: string, from: Date = new Date()): Date {
  const parsed = parseCronExpression(expression);

  const candidate = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
      from.getUTCHours(),
      from.getUTCMinutes()
    )
  );
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  const maxIterations = 60 * 24 * 366 * 2; // ~2 years of minutes
  for (let i = 0; i < maxIterations; i++) {
    if (
      parsed.minute.values.has(candidate.getUTCMinutes()) &&
      parsed.hour.values.has(candidate.getUTCHours()) &&
      parsed.dayOfMonth.values.has(candidate.getUTCDate()) &&
      parsed.month.values.has(candidate.getUTCMonth() + 1) &&
      parsed.dayOfWeek.values.has(candidate.getUTCDay())
    ) {
      return candidate;
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  throw new Error(`Could not find next occurrence for cron expression "${expression}" within 2 years`);
}

/**
 * Validates a cron expression using the same parser getNextCronOccurrenceInTimezone
 * uses (`cron-parser`), so a timezone-aware caller's validation and evaluation always
 * agree — the hand-rolled isValidCronExpression() above accepts the same 5-field
 * syntax but is intentionally not reused here to avoid a false "valid" from one parser
 * and a throw from the other on an edge case where their grammars diverge.
 */
export function isValidCronExpressionStrict(expression: string): boolean {
  try {
    CronExpressionParser.parse(expression, { currentDate: new Date() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the next occurrence of a cron expression evaluated in an IANA timezone
 * (e.g. "America/New_York"), correctly accounting for DST transitions (Issue #59).
 *
 * Delegates to `cron-parser`, which uses `luxon` internally for timezone-aware
 * field matching — "0 9 * * *" in "America/New_York" always means 9:00 local time,
 * whether that's UTC-05:00 (EST) or UTC-04:00 (EDT) on a given date.
 *
 * @param expression 5-field cron expression (same grammar as parseCronExpression).
 * @param timezone IANA timezone identifier. Defaults to UTC.
 * @param from Reference time to compute the next occurrence strictly after. Defaults to now.
 */
export function getNextCronOccurrenceInTimezone(
  expression: string,
  timezone: string = "UTC",
  from: Date = new Date()
): Date {
  try {
    const interval = CronExpressionParser.parse(expression, {
      currentDate: from,
      tz: timezone,
    });
    return interval.next().toDate();
  } catch (err) {
    throw new Error(
      `Could not compute next occurrence for cron expression "${expression}" in timezone "${timezone}": ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}
