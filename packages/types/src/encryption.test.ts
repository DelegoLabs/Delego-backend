import { describe, it, expect } from "vitest";
import {
  lookupPiiColumn,
  PII_REGISTRY,
  PII_REGISTRY_SUMMARY,
} from "./pii-registry.js";
import type {
  EncryptedField,
  EncryptionConfig,
  KeyAccessRecord,
  KeyRotationStatus,
  PiiAccessDecision,
  PiiClassification,
} from "./encryption.js";

describe("EncryptionConfig", () => {
  it("models the full config surface from issue #68", () => {
    const config: EncryptionConfig = {
      algorithm: "AES-256-GCM",
      keyProvider: "aws_kms",
      keyId: "arn:aws:kms:us-east-1:123456789:key/deadbeef",
      keyRotationDays: 90,
      contextField: "users.id",
    };
    expect(config.algorithm).toBe("AES-256-GCM");
    expect(config.keyRotationDays).toBe(90);
  });

  it("accepts every algorithm/provider combination", () => {
    const configs: EncryptionConfig[] = [
      { algorithm: "AES-256-CBC", keyProvider: "vault", keyId: "transit/pii", keyRotationDays: 30 },
      { algorithm: "AES-256-GCM", keyProvider: "local", keyId: "primary", keyRotationDays: 180 },
    ];
    expect(configs).toHaveLength(2);
  });
});

describe("EncryptedField", () => {
  it("carries ciphertext, iv, authTag, keyVersion and algorithm", () => {
    const field: EncryptedField = {
      ciphertext: "base64...",
      iv: "base64...",
      authTag: "base64...",
      keyVersion: 2,
      algorithm: "AES-256-GCM",
    };
    expect(field.keyVersion).toBe(2);
    expect(field.algorithm).toBe("AES-256-GCM");
  });
});

describe("KeyRotationStatus", () => {
  it("tracks previous version and scheduling for zero-downtime rotation", () => {
    const status: KeyRotationStatus = {
      keyId: "primary",
      currentVersion: 3,
      previousVersion: 2,
      rotationInProgress: true,
      lastRotatedAt: new Date().toISOString(),
      nextRotationAt: new Date().toISOString(),
    };
    expect(status.currentVersion).toBe(3);
    expect(status.previousVersion).toBe(2);
    expect(status.rotationInProgress).toBe(true);
  });
});

describe("PII_REGISTRY", () => {
  it("registers every classified column with all required metadata", () => {
    for (const entry of PII_REGISTRY) {
      expect(entry.table).toBeTruthy();
      expect(entry.column).toBeTruthy();
      expect(entry.classification).toBeTruthy();
      expect(Array.isArray(entry.decryptRoles)).toBe(true);
      expect(entry.decryptRoles.length).toBeGreaterThan(0);
    }
  });

  it("marks users.email as an indexed gdpr_pii column", () => {
    const email = lookupPiiColumn("users", "email");
    expect(email).toBeDefined();
    expect(email?.classification).toBe("gdpr_pii");
    expect(email?.indexed).toBe(true);
  });

  it("classifies payment_methods card data as pci_dss with admin-only decrypt", () => {
    const fingerprint = lookupPiiColumn("payment_methods", "fingerprint");
    expect(fingerprint?.classification).toBe("pci_dss" satisfies PiiClassification);
    expect(fingerprint?.decryptRoles).toContain("admin");
  });

  it("keeps credential columns system-only", () => {
    const pw = lookupPiiColumn("users", "password_hash");
    expect(pw?.decryptRoles).toEqual(["system"]);
  });

  it("returns undefined for non-PII columns", () => {
    expect(lookupPiiColumn("orders", "total_stroops")).toBeUndefined();
  });
});

describe("PiiAccessDecision", () => {
  it("models an allow/deny decision", () => {
    const decision: PiiAccessDecision = {
      allowed: false,
      table: "users",
      column: "email",
      role: "service",
      reason: "role not permitted",
    };
    expect(decision.allowed).toBe(false);
  });
});

describe("KeyAccessRecord", () => {
  it("captures the audit trail of a key use", () => {
    const record: KeyAccessRecord = {
      id: "1",
      occurredAt: new Date().toISOString(),
      table: "users",
      column: "email",
      operation: "decrypt",
      keyId: "primary",
      keyVersion: 1,
      actorRole: "support",
      context: { userId: "u1" },
      success: true,
    };
    expect(record.operation).toBe("decrypt");
    expect(record.success).toBe(true);
  });
});

describe("PII_REGISTRY_SUMMARY", () => {
  it("reports consistent table/column counts", () => {
    expect(PII_REGISTRY_SUMMARY.encryptedColumns).toBe(PII_REGISTRY.length);
    const tables = new Set(PII_REGISTRY.map((e) => e.table));
    expect(PII_REGISTRY_SUMMARY.tables).toBe(tables.size);
  });
});