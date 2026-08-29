/**
 * Unit tests for #148 — real-time matcher.
 */

import { describe, it, expect } from "vitest";
import { matchRecords, matchBatch } from "./realTimeMatcher.js";
import type {
  SettlementRecord,
  ExternalSettlementRecord,
} from "./enhancedTypes.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeInternal(overrides: Partial<SettlementRecord> = {}): SettlementRecord {
  return {
    id: "int-1",
    orderId: "ord-123",
    escrowId: "esc-1",
    amount: "1000000",
    currency: "XLM",
    status: "funded",
    reference: "REF-ABC-123",
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
    reference: "REF-ABC-123",
    timestamp: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("realTimeMatcher", () => {
  describe("matchRecords", () => {
    it("returns score 1 for exact match", () => {
      const match = matchRecords(makeInternal(), makeExternal());
      expect(match.matchScore).toBe(1);
      expect(match.matchType).toBe("exact");
      expect(match.discrepancies).toHaveLength(0);
    });

    it("detects amount discrepancy", () => {
      const match = matchRecords(
        makeInternal({ amount: "1000000" }),
        makeExternal({ amount: "999000" })
      );
      expect(match.matchScore).toBeLessThan(1);
      expect(match.discrepancies.some((d) => d.field === "amount")).toBe(true);
    });

    it("detects reference discrepancy", () => {
      const match = matchRecords(
        makeInternal({ reference: "REF-ABC-123" }),
        makeExternal({ reference: "REF-ABC-456" })
      );
      expect(match.matchScore).toBeLessThan(1);
      expect(match.discrepancies.some((d) => d.field === "reference")).toBe(true);
    });

    it("classifies severity correctly", () => {
      const match = matchRecords(
        makeInternal({ amount: "1000000" }),
        makeExternal({ amount: "500000" }) // 50% different
      );
      const amountDisc = match.discrepancies.find((d) => d.field === "amount");
      expect(amountDisc?.severity).toBe("critical");
    });

    it("handles missing reference gracefully", () => {
      const match = matchRecords(
        makeInternal({ reference: undefined }),
        makeExternal({ reference: "REF-123" })
      );
      // Should still match on amount and currency
      expect(match.matchScore).toBeGreaterThan(0);
    });
  });

  describe("matchBatch", () => {
    it("matches internal records to external records", () => {
      const internals = [
        makeInternal({ id: "int-1", reference: "REF-1" }),
        makeInternal({ id: "int-2", reference: "REF-2" }),
      ];
      const externals = [
        makeExternal({ id: "ext-1", reference: "REF-1" }),
        makeExternal({ id: "ext-2", reference: "REF-2" }),
      ];

      const matches = matchBatch(internals, externals);
      expect(matches).toHaveLength(2);
      expect(matches[0].internalRecordId).toBe("int-1");
      expect(matches[0].externalRecordId).toBe("ext-1");
      expect(matches[1].internalRecordId).toBe("int-2");
      expect(matches[1].externalRecordId).toBe("ext-2");
    });

    it("does not match the same external record twice", () => {
      const internals = [
        makeInternal({ id: "int-1", reference: "REF-1" }),
        makeInternal({ id: "int-2", reference: "REF-1" }),
      ];
      const externals = [
        makeExternal({ id: "ext-1", reference: "REF-1" }),
      ];

      const matches = matchBatch(internals, externals);
      expect(matches).toHaveLength(1);
    });

    it("returns empty for no matches", () => {
      const internals = [makeInternal({ reference: "REF-1" })];
      const externals = [makeExternal({ reference: "REF-999" })];

      const matches = matchBatch(internals, externals, {
        autoMatchThreshold: 0.99,
      });
      expect(matches).toHaveLength(0);
    });
  });
});
