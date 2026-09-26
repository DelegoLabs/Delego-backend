/**
 * Unit tests for #68 — field-level access control and key-access audit.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { FieldAccessController } from "./accessControl.js";
import { KeyAccessAuditor } from "./audit.js";
import { EncryptionError } from "./cipher.js";
import type { PiiColumn } from "@delegolabs/types";

afterEach(() => vi.restoreAllMocks());

function customRegistry(): Map<string, PiiColumn> {
  const entries: PiiColumn[] = [
    {
      table: "users",
      column: "email",
      classification: "gdpr_pii",
      indexed: true,
      decryptRoles: ["owner", "support", "compliance", "admin", "system"],
      purpose: "login",
    },
    {
      table: "users",
      column: "password_hash",
      classification: "credential",
      indexed: false,
      decryptRoles: ["system"],
      purpose: "hash",
    },
    {
      table: "payments",
      column: "pan",
      classification: "pci_dss",
      indexed: false,
      decryptRoles: ["admin", "compliance", "system"],
      purpose: "card",
    },
  ];
  const map = new Map<string, PiiColumn>();
  for (const entry of entries) map.set(`${entry.table}.${entry.column}`, entry);
  return map;
}

describe("FieldAccessController", () => {
  it("allows a role listed in the registry decrypt roles", () => {
    const registry = customRegistry();
    const controller = new FieldAccessController({
      lookup: (t, c) => registry.get(`${t}.${c}`),
    });
    expect(controller.decide("users", "email", "support").allowed).toBe(true);
  });

  it("denies a role not listed in the decrypt roles", () => {
    const registry = customRegistry();
    const controller = new FieldAccessController({
      lookup: (t, c) => registry.get(`${t}.${c}`),
    });
    const decision = controller.decide("payments", "pan", "service");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("service");
  });

  it("fails closed on unregistered columns", () => {
    const controller = new FieldAccessController({ lookup: () => undefined });
    expect(controller.decide("users", "not_pii", "admin").allowed).toBe(false);
    expect(() => controller.assertCanDecrypt("users", "not_pii", "admin")).toThrow(EncryptionError);
  });

  it("fails closed on columns with zero decrypt roles", () => {
    const controller = new FieldAccessController({
      lookup: () =>
        ({
          table: "t",
          column: "c",
          classification: "gdpr_pii",
          indexed: false,
          decryptRoles: [],
          purpose: "x",
        }) as PiiColumn,
    });
    expect(controller.decide("t", "c", "system").allowed).toBe(false);
  });

  it("assertCanDecrypt returns the registry entry when permitted", () => {
    const registry = customRegistry();
    const controller = new FieldAccessController({
      lookup: (t, c) => registry.get(`${t}.${c}`),
    });
    const entry = controller.assertCanDecrypt("users", "email", "admin");
    expect(entry.classification).toBe("gdpr_pii");
  });

  it("uses the @delegolabs/types registry by default", () => {
    const controller = new FieldAccessController();
    // users.email is a registered indexed column; a random one is not.
    expect(controller.decide("users", "email", "admin").allowed).toBe(true);
    expect(controller.decide("users", "totally_fake", "admin").allowed).toBe(false);
  });
});

describe("KeyAccessAuditor", () => {
  it("records successful and failed key accesses", async () => {
    const auditor = new KeyAccessAuditor({ maxRecords: 100 });
    await auditor.record({
      operation: "decrypt",
      keyId: "primary",
      keyVersion: 1,
      table: "users",
      column: "email",
      context: { userId: "u1" },
      actorRole: "support",
      success: true,
    });
    await auditor.record({
      operation: "decrypt",
      keyId: "primary",
      keyVersion: 1,
      table: "users",
      column: "password_hash",
      actorRole: "service",
      success: false,
      error: "Access denied",
    });

    const records = auditor.list();
    expect(records).toHaveLength(2);
    expect(records[0].success).toBe(false);
    expect(records[1].success).toBe(true);
  });

  it("exposes newest-first ordering and per-column filtering", async () => {
    const auditor = new KeyAccessAuditor();
    await auditor.record({ operation: "encrypt", keyId: "k", keyVersion: 1, table: "users", column: "email" });
    await auditor.record({ operation: "encrypt", keyId: "k", keyVersion: 1, table: "users", column: "display_name" });
    const emailRecords = auditor.listFor("users", "email");
    expect(emailRecords).toHaveLength(1);
    expect(emailRecords[0].column).toBe("email");
  });

  it("bounded memory: trims to maxRecords", async () => {
    const auditor = new KeyAccessAuditor({ maxRecords: 5 });
    for (let i = 0; i < 10; i += 1) {
      await auditor.record({ operation: "encrypt", keyId: "k", keyVersion: 1, table: "t", column: "c" });
    }
    expect(auditor.size).toBe(5);
  });

  it("writes to a pluggable sink but never throws on sink failure", async () => {
    const sink = { write: vi.fn().mockRejectedValue(new Error("db down")) };
    const auditor = new KeyAccessAuditor({ sink });
    await expect(
      auditor.record({ operation: "decrypt", keyId: "k", keyVersion: 1, table: "users", column: "email" })
    ).resolves.toBeDefined();
    expect(sink.write).toHaveBeenCalledTimes(1);
    // records still held in memory
    expect(auditor.size).toBe(1);
  });
});