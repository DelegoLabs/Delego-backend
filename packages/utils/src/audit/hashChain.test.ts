import { describe, it, expect } from "vitest";
import { computeEntryHash, verifyChain, type HashableAuditFields } from "./hashChain.js";
import type { AuditLogEntry } from "./types.js";

function fields(overrides: Partial<HashableAuditFields> = {}): HashableAuditFields {
  return {
    tableName: "users",
    recordId: "u1",
    operation: "UPDATE",
    userId: "admin-1",
    sessionId: "sess-1",
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
    oldValues: { name: "Alice" },
    newValues: { name: "Alicia" },
    changedFields: ["name"],
    occurredAt: new Date("2026-01-01T00:00:00Z"),
    transactionId: "tx-1",
    ...overrides,
  };
}

function entry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  const base = fields();
  return {
    id: "e1",
    sequenceNum: 1,
    tableName: base.tableName,
    recordId: base.recordId,
    operation: base.operation,
    userId: base.userId,
    sessionId: base.sessionId,
    ipAddress: base.ipAddress,
    userAgent: base.userAgent,
    oldValues: base.oldValues,
    newValues: base.newValues,
    changedFields: base.changedFields,
    occurredAt: base.occurredAt,
    transactionId: base.transactionId,
    prevHash: null,
    entryHash: "",
    ...overrides,
  };
}

describe("computeEntryHash", () => {
  it("is deterministic for identical input", () => {
    const h1 = computeEntryHash(fields(), null);
    const h2 = computeEntryHash(fields(), null);
    expect(h1).toBe(h2);
  });

  it("produces a 64-char hex SHA-256 digest", () => {
    const h = computeEntryHash(fields(), null);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when prevHash changes, even with identical fields", () => {
    const h1 = computeEntryHash(fields(), null);
    const h2 = computeEntryHash(fields(), "some-other-hash");
    expect(h1).not.toBe(h2);
  });

  it("changes when any field changes", () => {
    const base = computeEntryHash(fields(), null);
    expect(computeEntryHash(fields({ recordId: "u2" }), null)).not.toBe(base);
    expect(computeEntryHash(fields({ operation: "DELETE" }), null)).not.toBe(base);
    expect(computeEntryHash(fields({ newValues: { name: "Someone Else" } }), null)).not.toBe(base);
  });

  it("is independent of key insertion order in oldValues/newValues", () => {
    const a = computeEntryHash(fields({ newValues: { a: 1, b: 2 } }), null);
    const b = computeEntryHash(fields({ newValues: { b: 2, a: 1 } }), null);
    expect(a).toBe(b);
  });

  it("is independent of changedFields array order", () => {
    const a = computeEntryHash(fields({ changedFields: ["name", "email"] }), null);
    const b = computeEntryHash(fields({ changedFields: ["email", "name"] }), null);
    expect(a).toBe(b);
  });

  it("treats null and empty-object oldValues/newValues distinctly", () => {
    const withNull = computeEntryHash(fields({ oldValues: null }), null);
    const withEmpty = computeEntryHash(fields({ oldValues: {} }), null);
    expect(withNull).not.toBe(withEmpty);
  });
});

describe("verifyChain", () => {
  it("returns valid for an empty chain", () => {
    const result = verifyChain([]);
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(0);
  });

  it("validates a correctly chained sequence of entries", () => {
    const f1 = fields({ recordId: "u1" });
    const h1 = computeEntryHash(f1, null);
    const e1 = entry({ id: "e1", recordId: "u1", prevHash: null, entryHash: h1 });

    const f2 = fields({ recordId: "u2", operation: "DELETE" });
    const h2 = computeEntryHash(f2, h1);
    const e2 = entry({ id: "e2", recordId: "u2", operation: "DELETE", prevHash: h1, entryHash: h2 });

    const result = verifyChain([e1, e2]);
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(2);
    expect(result.firstBrokenEntryId).toBeNull();
  });

  it("detects a tampered entryHash and reports the first broken entry", () => {
    const f1 = fields({ recordId: "u1" });
    const h1 = computeEntryHash(f1, null);
    const e1 = entry({ id: "e1", recordId: "u1", prevHash: null, entryHash: h1 });

    const f2 = fields({ recordId: "u2" });
    const h2 = computeEntryHash(f2, h1);
    // Tamper: change the stored newValues after the hash was computed.
    const e2 = entry({
      id: "e2",
      recordId: "u2",
      newValues: { name: "TAMPERED" },
      prevHash: h1,
      entryHash: h2,
    });

    const result = verifyChain([e1, e2]);
    expect(result.valid).toBe(false);
    expect(result.entriesChecked).toBe(1);
    expect(result.firstBrokenEntryId).toBe("e2");
    expect(result.reason).toMatch(/entryHash mismatch/);
  });

  it("detects a removed entry via a broken prevHash link", () => {
    const f1 = fields({ recordId: "u1" });
    const h1 = computeEntryHash(f1, null);
    const e1 = entry({ id: "e1", recordId: "u1", prevHash: null, entryHash: h1 });

    const f2 = fields({ recordId: "u2" });
    const h2 = computeEntryHash(f2, h1);
    // e2 itself is never included below — its hash only matters as the
    // link e3.prevHash is expected to point at.

    const f3 = fields({ recordId: "u3" });
    const h3 = computeEntryHash(f3, h2);
    const e3 = entry({ id: "e3", recordId: "u3", prevHash: h2, entryHash: h3 });

    // Simulate e2 being deleted from the table: e3 now sits right after e1,
    // but its prevHash still points at the (now missing) e2's hash.
    const result = verifyChain([e1, e3]);
    expect(result.valid).toBe(false);
    expect(result.entriesChecked).toBe(1);
    expect(result.firstBrokenEntryId).toBe("e3");
    expect(result.reason).toMatch(/prevHash mismatch/);
  });

  it("detects a chain that doesn't start with prevHash null", () => {
    const f1 = fields();
    const h1 = computeEntryHash(f1, "not-actually-the-start");
    const e1 = entry({ id: "e1", prevHash: "not-actually-the-start", entryHash: h1 });

    const result = verifyChain([e1]);
    expect(result.valid).toBe(false);
    expect(result.firstBrokenEntryId).toBe("e1");
  });
});
