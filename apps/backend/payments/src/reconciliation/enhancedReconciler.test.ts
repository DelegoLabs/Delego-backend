/**
 * Unit tests for #148 — reconciliation rules engine and SLA monitor.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { evaluateRules, DEFAULT_RULES } from "./reconciliationRules.js";
import { SLATracker, DEFAULT_SLAS } from "./slaMonitor.js";
import type {
  SettlementMatch,
  SettlementRecord,
  ExternalSettlementRecord,
} from "./enhancedTypes.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeMatch(overrides: Partial<SettlementMatch> = {}): SettlementMatch {
  return {
    internalRecordId: "int-1",
    externalRecordId: "ext-1",
    matchScore: 1,
    matchType: "exact",
    discrepancies: [],
    ...overrides,
  };
}

function makeInternal(overrides: Partial<SettlementRecord> = {}): SettlementRecord {
  return {
    id: "int-1",
    orderId: "ord-123",
    escrowId: "esc-1",
    amount: "1000000",
    currency: "XLM",
    status: "funded",
    reference: "REF-123",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeExternal(overrides: Partial<ExternalSettlementRecord> = {}): ExternalSettlementRecord {
  return {
    id: "ext-1",
    amount: "1000000",
    currency: "XLM",
    status: "completed",
    reference: "REF-123",
    timestamp: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

// ─── Rules Tests ──────────────────────────────────────────────────────────────

describe("reconciliation rules", () => {
  it("auto-matches exact matches", () => {
    const result = evaluateRules(
      makeMatch({ matchScore: 1, discrepancies: [] }),
      makeInternal(),
      makeExternal()
    );
    expect(result.action).toBe("auto_match");
    expect(result.matchedRules[0]?.ruleId).toBe("exact_match_auto");
  });

  it("auto-resolves high-confidence fuzzy matches", () => {
    const result = evaluateRules(
      makeMatch({
        matchScore: 0.97,
        matchType: "fuzzy",
        discrepancies: [
          { field: "reference", internalValue: "REF-123", externalValue: "REF-124", severity: "minor" },
        ],
      }),
      makeInternal(),
      makeExternal()
    );
    expect(result.action).toBe("auto_resolve");
  });

  it("flags medium-confidence matches for review", () => {
    const result = evaluateRules(
      makeMatch({
        matchScore: 0.85,
        matchType: "fuzzy",
        discrepancies: [
          { field: "reference", internalValue: "REF-123", externalValue: "REF-999", severity: "major" },
        ],
      }),
      makeInternal(),
      makeExternal()
    );
    expect(result.action).toBe("flag_review");
  });

  it("escalates low-confidence matches", () => {
    const result = evaluateRules(
      makeMatch({
        matchScore: 0.5,
        matchType: "fuzzy",
        discrepancies: [
          { field: "amount", internalValue: "1000000", externalValue: "500000", severity: "critical" },
        ],
      }),
      makeInternal(),
      makeExternal()
    );
    expect(result.action).toBe("escalate");
  });

  it("escalates critical discrepancies regardless of score", () => {
    const result = evaluateRules(
      makeMatch({
        matchScore: 0.95,
        discrepancies: [
          { field: "amount", internalValue: "1000000", externalValue: "500000", severity: "critical" },
        ],
      }),
      makeInternal(),
      makeExternal()
    );
    expect(result.action).toBe("escalate");
  });

  it("generates audit entry", () => {
    const result = evaluateRules(
      makeMatch({ matchScore: 1 }),
      makeInternal(),
      makeExternal()
    );
    expect(result.auditEntry).toBeDefined();
    expect(result.auditEntry.action).toBe("matched");
    expect(result.auditEntry.performedBy).toBe("system");
  });
});

// ─── SLA Monitor Tests ────────────────────────────────────────────────────────

describe("SLA tracker", () => {
  let tracker: SLATracker;

  beforeEach(() => {
    tracker = new SLATracker([
      {
        id: "test-sla",
        name: "Test SLA",
        targetResolutionMs: 100,
        warningThresholdPercent: 80,
        escalationThresholdPercent: 100,
        enabled: true,
      },
    ]);
  });

  it("starts tracking a discrepancy", () => {
    const status = tracker.startTracking("disc-1", false);
    expect(status.discrepancyId).toBe("disc-1");
    expect(status.status).toBe("on_track");
  });

  it("resolves tracking", () => {
    tracker.startTracking("disc-1", false);
    const resolved = tracker.resolve("disc-1");
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolutionTimeMs).toBeDefined();
  });

  it("returns compliance stats", () => {
    tracker.startTracking("disc-1", false);
    tracker.resolve("disc-1");

    const stats = tracker.getComplianceStats();
    expect(stats.total).toBe(1);
    expect(stats.resolved).toBe(1);
    expect(stats.complianceRate).toBe(100);
  });

  it("returns active SLAs", () => {
    tracker.startTracking("disc-1", false);
    tracker.startTracking("disc-2", true);

    const active = tracker.getActiveSLAs();
    expect(active).toHaveLength(2);
  });
});
