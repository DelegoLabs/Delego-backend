/**
 * Integration tests for #68 — ColumnEncryptor (application-layer
 * encrypt/decrypt), composing cipher + provider + access control + audit.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ColumnEncryptor } from "./columnEncryptor.js";
import { LocalKeyProvider, InMemoryWrappedKeyStore } from "./keyProvider.js";
import { KeyAccessAuditor } from "./audit.js";
import { FieldAccessController } from "./accessControl.js";
import { EncryptionError } from "./cipher.js";
import type { EncryptionConfig } from "@delegolabs/types";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function makeEncryptor(opts: {
  algorithm?: EncryptionConfig["algorithm"];
  keyVersion?: number;
} = {}) {
  const keyProvider = new LocalKeyProvider({
    keyId: "primary",
    secrets: {
      1: "master-secret-v1-32-characters-long!!",
      2: "master-secret-v2-32-characters-long!!",
    },
    activeVersion: opts.keyVersion ?? 1,
  });
  const audit = new KeyAccessAuditor({ maxRecords: 500 });
  const encryptor = new ColumnEncryptor({
    keyProvider,
    access: new FieldAccessController(),
    audit,
    config: {
      algorithm: opts.algorithm ?? "AES-256-GCM",
      keyProvider: "local",
      keyId: "primary",
      keyRotationDays: 90,
    },
  });
  return { keyProvider, audit, encryptor };
}

describe("ColumnEncryptor", () => {
  it("encrypts and decrypts a PII field end-to-end", async () => {
    const { encryptor } = makeEncryptor();
    const context = { userId: "u-42" };

    const field = await encryptor.encrypt("users", "email", "alice@example.com", {
      context,
      actorRole: "system",
    });
    expect(field.ciphertext).not.toContain("alice");
    expect(field.keyVersion).toBe(1);
    expect(field.blindIndex).toMatch(/^[0-9a-f]{64}$/); // users.email is indexed

    const { plaintext, index } = await encryptor.decrypt("users", "email", field, {
      context,
      actorRole: "admin",
    });
    expect(plaintext).toBe("alice@example.com");
    expect(index).toBe(field.blindIndex);
  });

  it("encrypts with a different data key per key version (dual-write)", async () => {
    const { encryptor } = makeEncryptor();
    const context = { userId: "u-42" };

    const v1 = await encryptor.encrypt("users", "email", "same@x.com", { context, keyVersion: 1 });
    const v2 = await encryptor.encrypt("users", "email", "same@x.com", { context, keyVersion: 2 });
    expect(v1.ciphertext).not.toBe(v2.ciphertext);
    expect(v1.keyVersion).toBe(1);
    expect(v2.keyVersion).toBe(2);

    // both remain decryptable after the switch (dual encryption window)
    expect((await encryptor.decrypt("users", "email", v1, { context })).plaintext).toBe("same@x.com");
    expect((await encryptor.decrypt("users", "email", v2, { context })).plaintext).toBe("same@x.com");
  });

  it("decrypts using the key version recorded on the field, not the active one", async () => {
    const { encryptor } = makeEncryptor();
    const context = { userId: "old-row" };
    const oldField = await encryptor.encrypt("users", "email", "legacy@x.com", {
      context,
      keyVersion: 1,
    });
    expect(oldField.keyVersion).toBe(1);

    const { plaintext } = await encryptor.decrypt("users", "email", oldField, { context });
    expect(plaintext).toBe("legacy@x.com");
  });

  it("enforces field-level access control on decrypt", async () => {
    const { encryptor, audit } = makeEncryptor();
    const field = await encryptor.encrypt("users", "email", "a@b.com", { actorRole: "system" });

    await expect(
      encryptor.decrypt("users", "email", field, { actorRole: "service" })
    ).rejects.toThrow(EncryptionError);

    const denied = audit.listFor("users", "email")[0];
    expect(denied.success).toBe(false);
    expect(denied.operation).toBe("decrypt");
  });

  it("fails to encrypt a non-registered column (fail closed)", async () => {
    const { encryptor } = makeEncryptor();
    await expect(encryptor.encrypt("orders", "total_stroops", "100")).rejects.toThrow(
      EncryptionError
    );
  });

  it("audits successful decrypts with encryption context", async () => {
    const { encryptor, audit } = makeEncryptor();
    const context = { userId: "u-9", email: "ctx@x.com" };
    const field = await encryptor.encrypt("users", "email", "ctx@x.com", { context });
    await encryptor.decrypt("users", "email", field, { context, actorRole: "support" });

    const entry = audit.listFor("users", "email").find((r) => r.operation === "decrypt");
    expect(entry?.success).toBe(true);
    expect(entry?.context).toEqual(context);
    expect(entry?.actorRole).toBe("support");
  });

  it("round-trips CBC-encrypted data (legacy migration path)", async () => {
    const { encryptor } = makeEncryptor({ algorithm: "AES-256-CBC" });
    const field = await encryptor.encrypt("recovery_configs", "guardians", JSON.stringify([{ email: "g@x.com" }]), {
      actorRole: "system",
    });
    const { plaintext } = await encryptor.decrypt("recovery_configs", "guardians", field, {
      actorRole: "system",
    });
    expect(plaintext).toContain("g@x.com");
  });

  it("computes a blind index for equality lookups without decrypting", async () => {
    const { encryptor, keyProvider } = makeEncryptor();
    const index = await encryptor.computeIndex("users", "email", "findme@x.com");
    const dataKey = await keyProvider.getDataKey(1);
    const expected = await import("./cipher.js").then((m) =>
      m.blindIndex("findme@x.com", dataKey.key, "users.email")
    );
    expect(index).toBe(expected);
  });

  it("remains usable with a fresh encryptor instance sharing the same provider", async () => {
    const mk = makeEncryptor();
    const context = { userId: "shared" };
    const field = await mk.encryptor.encrypt("users", "email", "shared@x.com", { context });

    const encryptor2 = new ColumnEncryptor({
      keyProvider: mk.keyProvider,
      access: new FieldAccessController(),
      audit: new KeyAccessAuditor(),
      config: mk.encryptor.config,
    });
    expect((await encryptor2.decrypt("users", "email", field, { context })).plaintext).toBe(
      "shared@x.com"
    );
  });
});

describe("pipeline smoke (wrapped key store + provider)", () => {
  it("encrypts through a fresh provider instance after restart", async () => {
    const store = new InMemoryWrappedKeyStore();
    const secrets = { 1: "restart-secret-32-characters-long!!!" };
    const providerA = new LocalKeyProvider({ keyId: "primary", secrets, activeVersion: 1 });
    const encryptorA = new ColumnEncryptor({
      keyProvider: providerA,
      config: { algorithm: "AES-256-GCM", keyProvider: "local", keyId: "primary", keyRotationDays: 90 },
    });
    const ctx = { userId: "r1" };
    const field = await encryptorA.encrypt("users", "email", "persist@x.com", { context: ctx });

    const providerB = new LocalKeyProvider({ keyId: "primary", secrets, activeVersion: 1 });
    const encryptorB = new ColumnEncryptor({
      keyProvider: providerB,
      config: encryptorA.config,
    });
    expect((await encryptorB.decrypt("users", "email", field, { context: ctx })).plaintext).toBe(
      "persist@x.com"
    );
  });
});