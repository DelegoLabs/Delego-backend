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
});

describe("serializeLogEntry", () => {
  it("serializes to valid JSON matching the entry's shape", () => {
    const entry = formatLogEntry({ level: "info", service: "gateway", message: "hi" });
    const line = serializeLogEntry(entry);
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
});
