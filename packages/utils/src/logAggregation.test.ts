import { describe, it, expect } from "vitest";
import {
  formatLogEntry,
  serializeLogEntry,
  matchesLogQuery,
  validateRetentionPolicies,
  isLogPipelineHealthy,
  type LogEntry,
  type LogRetentionPolicy,
} from "./logAggregation.js";

describe("formatLogEntry", () => {
  it("builds a structured entry with an RFC3339 timestamp", () => {
    const now = () => new Date("2026-01-01T00:00:00.000Z");
    const entry = formatLogEntry({ level: "info", service: "gateway", message: "started", now });
    expect(entry.timestamp).toBe("2026-01-01T00:00:00.000Z");
    expect(entry.level).toBe("info");
    expect(entry.service).toBe("gateway");
    expect(entry.fields).toEqual({});
  });

  it("includes traceId and spanId when provided", () => {
    const entry = formatLogEntry({ level: "info", service: "gateway", message: "x", traceId: "t1", spanId: "s1" });
    expect(entry.traceId).toBe("t1");
    expect(entry.spanId).toBe("s1");
  });

  it("omits traceId/spanId when not provided", () => {
    const entry = formatLogEntry({ level: "info", service: "gateway", message: "x" });
    expect(entry.traceId).toBeUndefined();
    expect(entry.spanId).toBeUndefined();
  });

  it("includes a structured error when an Error is provided", () => {
    const err = new Error("boom");
    const entry = formatLogEntry({ level: "error", service: "gateway", message: "failed", error: err });
    expect(entry.error?.name).toBe("Error");
    expect(entry.error?.message).toBe("boom");
    expect(entry.error?.stack).toBeTruthy();
  });

  it("passes through custom fields", () => {
    const entry = formatLogEntry({ level: "info", service: "gateway", message: "x", fields: { userId: "u1" } });
    expect(entry.fields).toEqual({ userId: "u1" });
  });

  it("uses the current time when no clock is injected", () => {
    const before = Date.now();
    const entry = formatLogEntry({ level: "info", service: "gateway", message: "x" });
    const after = Date.now();

    expect(new Date(entry.timestamp).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(entry.timestamp).getTime()).toBeLessThanOrEqual(after);
  });

  it("omits empty traceId and spanId values", () => {
    const entry = formatLogEntry({ level: "info", service: "gateway", message: "x", traceId: "", spanId: "" });
    expect(entry.traceId).toBeUndefined();
    expect(entry.spanId).toBeUndefined();
  });

  it("uses an empty string when an Error has no stack", () => {
    const err = new Error("no stack");
    err.stack = undefined;
    const entry = formatLogEntry({ level: "error", service: "gateway", message: "failed", error: err });
    expect(entry.error).toEqual({ name: "Error", message: "no stack", stack: "" });
  });

  it("preserves a custom error name", () => {
    const err = new TypeError("bad input");
    const entry = formatLogEntry({ level: "error", service: "gateway", message: "failed", error: err });
    expect(entry.error?.name).toBe("TypeError");
  });
});

describe("serializeLogEntry", () => {
  it("serializes to valid JSON matching the entry's shape", () => {
    const entry = formatLogEntry({ level: "info", service: "gateway", message: "hi" });
    const line = serializeLogEntry(entry);
    expect(JSON.parse(line)).toEqual(entry);
  });

  it("escapes newlines and quotes into a single log line", () => {
    const entry = buildEntry({ message: 'say "hello"\nnext line' });
    const line = serializeLogEntry(entry);

    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual(entry);
  });
});

function buildEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: "2026-01-15T12:00:00.000Z",
    level: "info",
    service: "gateway",
    message: "request handled",
    fields: {},
    ...overrides,
  };
}

describe("matchesLogQuery", () => {
  const baseQuery = { startTime: "2026-01-01T00:00:00.000Z", endTime: "2026-02-01T00:00:00.000Z", limit: 100 };

  it("matches an entry within the time range with no other filters", () => {
    expect(matchesLogQuery(buildEntry(), baseQuery)).toBe(true);
  });

  it("excludes an entry outside the time range", () => {
    const entry = buildEntry({ timestamp: "2025-01-01T00:00:00.000Z" });
    expect(matchesLogQuery(entry, baseQuery)).toBe(false);
  });

  it("filters by service", () => {
    const entry = buildEntry({ service: "wallet" });
    expect(matchesLogQuery(entry, { ...baseQuery, service: "gateway" })).toBe(false);
    expect(matchesLogQuery(entry, { ...baseQuery, service: "wallet" })).toBe(true);
  });

  it("filters by traceId", () => {
    const entry = buildEntry({ traceId: "abc" });
    expect(matchesLogQuery(entry, { ...baseQuery, traceId: "xyz" })).toBe(false);
    expect(matchesLogQuery(entry, { ...baseQuery, traceId: "abc" })).toBe(true);
  });

  it("filters by minimum level severity (level acts as a floor, not exact match)", () => {
    const warnEntry = buildEntry({ level: "warn" });
    const debugEntry = buildEntry({ level: "debug" });
    expect(matchesLogQuery(warnEntry, { ...baseQuery, level: "warn" })).toBe(true);
    expect(matchesLogQuery(debugEntry, { ...baseQuery, level: "warn" })).toBe(false);
  });

  it("filters by a message substring filter", () => {
    const entry = buildEntry({ message: "connection refused" });
    expect(matchesLogQuery(entry, { ...baseQuery, filter: "refused" })).toBe(true);
    expect(matchesLogQuery(entry, { ...baseQuery, filter: "timeout" })).toBe(false);
  });

  it("includes entries exactly on the start and end boundaries", () => {
    const timestamp = "2026-01-15T12:00:00.000Z";
    const boundaryQuery = { ...baseQuery, startTime: timestamp, endTime: timestamp };
    expect(matchesLogQuery(buildEntry({ timestamp }), boundaryQuery)).toBe(true);
  });

  it("excludes an entry after the end boundary", () => {
    const entry = buildEntry({ timestamp: "2026-03-01T00:00:00.000Z" });
    expect(matchesLogQuery(entry, baseQuery)).toBe(false);
  });

  it("matches nothing when the time range is inverted", () => {
    const entry = buildEntry();
    expect(
      matchesLogQuery(entry, { ...baseQuery, startTime: "2026-02-01T00:00:00.000Z", endTime: "2026-01-01T00:00:00.000Z" }),
    ).toBe(false);
  });

  it("treats empty optional filters as absent", () => {
    const entry = buildEntry();
    expect(
      matchesLogQuery(entry, { ...baseQuery, service: "", traceId: "", level: "", filter: "" }),
    ).toBe(true);
  });

  it("does not match an entry without a traceId when one is requested", () => {
    expect(matchesLogQuery(buildEntry(), { ...baseQuery, traceId: "abc" })).toBe(false);
  });

  it("compares service and filter values case-sensitively", () => {
    const entry = buildEntry({ service: "Gateway", message: "Request handled" });
    expect(matchesLogQuery(entry, { ...baseQuery, service: "gateway" })).toBe(false);
    expect(matchesLogQuery(entry, { ...baseQuery, filter: "request" })).toBe(false);
  });

  it("applies the level floor across the full severity ladder", () => {
    const expectations: Record<string, boolean> = {
      debug: false,
      info: false,
      warn: false,
      error: true,
      fatal: true,
    };
    for (const [level, expected] of Object.entries(expectations)) {
      expect(matchesLogQuery(buildEntry({ level: level as LogEntry["level"] }), { ...baseQuery, level: "error" })).toBe(
        expected,
      );
    }
  });
});

describe("validateRetentionPolicies", () => {
  function buildPolicy(overrides: Partial<LogRetentionPolicy> = {}): LogRetentionPolicy {
    return { level: "info", retentionDays: 30, storageClass: "hot", compressionEnabled: false, ...overrides };
  }

  it("passes a valid set of policies covering all levels with sane tier ordering", () => {
    const policies = [
      buildPolicy({ level: "debug", retentionDays: 7, storageClass: "hot" }),
      buildPolicy({ level: "info", retentionDays: 30, storageClass: "hot" }),
      buildPolicy({ level: "warn", retentionDays: 90, storageClass: "warm" }),
      buildPolicy({ level: "error", retentionDays: 365, storageClass: "cold" }),
      buildPolicy({ level: "fatal", retentionDays: 365, storageClass: "cold" }),
    ];
    const result = validateRetentionPolicies(policies);
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("warns about a missing level policy", () => {
    const policies = [buildPolicy({ level: "info" })];
    const result = validateRetentionPolicies(policies);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("fails a policy with non-positive retentionDays", () => {
    const policies = [buildPolicy({ retentionDays: 0 })];
    expect(validateRetentionPolicies(policies).valid).toBe(false);
  });

  it("fails when a hot-tier policy retains longer than a cold-tier policy", () => {
    const policies = [
      buildPolicy({ level: "debug", storageClass: "hot", retentionDays: 400 }),
      buildPolicy({ level: "error", storageClass: "cold", retentionDays: 30 }),
    ];
    const result = validateRetentionPolicies(policies);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/hotter/);
  });

  it("warns for every level when no policies are configured", () => {
    const result = validateRetentionPolicies([]);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      "No retention policy defined for level 'debug'",
      "No retention policy defined for level 'info'",
      "No retention policy defined for level 'warn'",
      "No retention policy defined for level 'error'",
      "No retention policy defined for level 'fatal'",
    ]);
  });

  it("fails a policy with negative retentionDays", () => {
    const result = validateRetentionPolicies([buildPolicy({ retentionDays: -1 })]);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Retention policy for 'info' has non-positive retentionDays");
  });

  it("validates the last policy when a level is defined more than once", () => {
    const policies = [
      buildPolicy({ level: "info", storageClass: "hot", retentionDays: 30 }),
      buildPolicy({ level: "info", storageClass: "hot", retentionDays: -1 }),
    ];
    const result = validateRetentionPolicies(policies);
    expect(result.errors).toEqual(["Retention policy for 'info' has non-positive retentionDays"]);
  });

  it("allows different retention periods within the same storage tier", () => {
    const policies = [
      buildPolicy({ level: "info", storageClass: "hot", retentionDays: 30 }),
      buildPolicy({ level: "warn", storageClass: "hot", retentionDays: 7 }),
    ];
    const result = validateRetentionPolicies(policies);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails when a warm-tier policy retains longer than a cold-tier policy", () => {
    const policies = [
      buildPolicy({ level: "warn", storageClass: "warm", retentionDays: 400 }),
      buildPolicy({ level: "fatal", storageClass: "cold", retentionDays: 30 }),
    ];
    const result = validateRetentionPolicies(policies);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/warm.*cold.*hotter/);
  });

  it("allows a cold-tier policy to retain longer than a hot-tier policy", () => {
    const policies = [
      buildPolicy({ level: "info", storageClass: "hot", retentionDays: 30 }),
      buildPolicy({ level: "error", storageClass: "cold", retentionDays: 365 }),
    ];
    expect(validateRetentionPolicies(policies).valid).toBe(true);
  });

  it("aggregates missing-level warnings and tier-ordering errors", () => {
    const policies = [
      buildPolicy({ level: "debug", storageClass: "hot", retentionDays: 400 }),
      buildPolicy({ level: "error", storageClass: "cold", retentionDays: 30 }),
    ];
    const result = validateRetentionPolicies(policies);
    expect(result.valid).toBe(false);
    expect(result.warnings).toContain("No retention policy defined for level 'info'");
    expect(result.warnings).toContain("No retention policy defined for level 'warn'");
    expect(result.warnings).toContain("No retention policy defined for level 'fatal'");
    expect(result.errors).toHaveLength(1);
  });
});

describe("isLogPipelineHealthy", () => {
  it("reports healthy when compliant and low error rate", () => {
    const healthy = isLogPipelineHealthy({
      ingestionRate: 1000,
      errorRate: 0.001,
      avgLatencyMs: 50,
      storageUsed: 1000,
      retentionCompliance: true,
    });
    expect(healthy).toBe(true);
  });

  it("reports unhealthy when retention is non-compliant", () => {
    const healthy = isLogPipelineHealthy({
      ingestionRate: 1000,
      errorRate: 0.001,
      avgLatencyMs: 50,
      storageUsed: 1000,
      retentionCompliance: false,
    });
    expect(healthy).toBe(false);
  });

  it("reports unhealthy when error rate is too high", () => {
    const healthy = isLogPipelineHealthy({
      ingestionRate: 1000,
      errorRate: 0.05,
      avgLatencyMs: 50,
      storageUsed: 1000,
      retentionCompliance: true,
    });
    expect(healthy).toBe(false);
  });

  it("treats an error rate of exactly 1% as unhealthy", () => {
    expect(
      isLogPipelineHealthy({
        ingestionRate: 1000,
        errorRate: 0.01,
        avgLatencyMs: 50,
        storageUsed: 1000,
        retentionCompliance: true,
      }),
    ).toBe(false);
  });

  it("accepts a zero error rate with no ingestion or latency constraints", () => {
    expect(
      isLogPipelineHealthy({
        ingestionRate: 0,
        errorRate: 0,
        avgLatencyMs: Number.MAX_SAFE_INTEGER,
        storageUsed: 0,
        retentionCompliance: true,
      }),
    ).toBe(true);
  });

  it("is unhealthy when both retention compliance and error rate fail", () => {
    expect(
      isLogPipelineHealthy({
        ingestionRate: 1000,
        errorRate: 0.5,
        avgLatencyMs: 50,
        storageUsed: 1000,
        retentionCompliance: false,
      }),
    ).toBe(false);
  });
});
