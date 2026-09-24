/**
 * Unit tests for #68 — AES-256-GCM/CBC cipher primitives, context AAD binding
 * and blind indexes.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as crypto from "node:crypto";
import {
  encryptField,
  decryptField,
  blindIndex,
  serializeContext,
  contextAad,
  EncryptionError,
  GCM_IV_LENGTH,
  CBC_IV_LENGTH,
} from "./cipher.js";

const KEY = crypto.randomBytes(32);

describe("encryptField / decryptField (AES-256-GCM)", () => {
  it("round-trips plaintext", () => {
    const field = encryptField("alice@example.com", KEY, "AES-256-GCM");
    expect(field.algorithm).toBe("AES-256-GCM");
    expect(field.ciphertext).not.toContain("alice");
    expect(decryptField(field, KEY)).toBe("alice@example.com");
  });

  it("produces unique ciphertext + IV per encryption (non-deterministic)", () => {
    const a = encryptField("same", KEY, "AES-256-GCM");
    const b = encryptField("same", KEY, "AES-256-GCM");
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
    expect(a.authTag).not.toBe(b.authTag);
  });

  it("uses 12-byte base64 IVs and 16-byte auth tags for GCM", () => {
    const field = encryptField("x", KEY, "AES-256-GCM");
    expect(Buffer.from(field.iv, "base64")).toHaveLength(GCM_IV_LENGTH);
    expect(Buffer.from(field.authTag, "base64")).toHaveLength(16);
  });

  it("binds ciphertext to the encryption context (AAD)", () => {
    const ctx = { userId: "u-123", email: "a@b.com" };
    const field = encryptField("secret", KEY, "AES-256-GCM", ctx);
    expect(decryptField(field, KEY, ctx)).toBe("secret");

    expect(() => decryptField(field, KEY)).toThrow(EncryptionError);
    expect(() => decryptField(field, KEY, { userId: "u-OTHER" })).toThrow(EncryptionError);
  });

  it("fails decryption when the auth tag is tampered with", () => {
    const field = encryptField("value", KEY, "AES-256-GCM");
    const tampered = { ...field, authTag: Buffer.from("00".repeat(16), "hex").toString("base64") };
    expect(() => decryptField(tampered, KEY)).toThrow(EncryptionError);
  });

  it("fails decryption when ciphertext is tampered with", () => {
    const field = encryptField("value", KEY, "AES-256-GCM");
    const bytes = Buffer.from(field.ciphertext, "base64");
    bytes[0] ^= 0xff;
    expect(() => decryptField({ ...field, ciphertext: bytes.toString("base64") }, KEY)).toThrow(
      EncryptionError
    );
  });

  it("rejects an empty plaintext and a wrong-size key", () => {
    expect(() => encryptField("", KEY, "AES-256-GCM")).toThrow(EncryptionError);
    expect(() => encryptField("x", crypto.randomBytes(16), "AES-256-GCM")).toThrow(EncryptionError);
  });

  it("matches a reference OpenSSL implementation (cross-check)", () => {
    const field = encryptField("payload", KEY, "AES-256-GCM", { row: "r1" });
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(field.iv, "base64"));
    decipher.setAAD(contextAad({ row: "r1" }));
    decipher.setAuthTag(Buffer.from(field.authTag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(field.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    expect(plain).toBe("payload");
  });
});

describe("AES-256-CBC legacy mode", () => {
  it("round-trips plaintext with PKCS#7 padding", () => {
    const field = encryptField("legacy-data", KEY, "AES-256-CBC");
    expect(field.algorithm).toBe("AES-256-CBC");
    expect(field.authTag).toBe("");
    expect(Buffer.from(field.iv, "base64")).toHaveLength(CBC_IV_LENGTH);
    expect(decryptField(field, KEY)).toBe("legacy-data");
  });

  it("rejects a value decrypted by a different key", () => {
    const field = encryptField("data", KEY, "AES-256-CBC");
    expect(() => decryptField(field, crypto.randomBytes(32))).toThrow(EncryptionError);
  });
});

describe("serializeContext / contextAad", () => {
  it("is deterministic regardless of object key order", () => {
    expect(serializeContext({ a: "1", b: "2" })).toBe(serializeContext({ b: "2", a: "1" }));
    expect(contextAad({ a: "1", b: "2" })).toEqual(contextAad({ b: "2", a: "1" }));
  });

  it("drops empty values so null/undefined contexts are equivalent", () => {
    expect(contextAad({ a: "x", b: "" })).toEqual(contextAad({ a: "x" }));
    expect(contextAad({})).toEqual(contextAad({ empty: "" }));
    expect(contextAad({} as Record<string, string>)).toEqual(contextAad(undefined as any));
  });
});

describe("blindIndex", () => {
  let indexKey: Buffer;
  beforeEach(() => {
    indexKey = crypto.randomBytes(32);
  });

  it("is deterministic for the same value, namespace and key", () => {
    expect(blindIndex("alice@example.com", indexKey, "users.email")).toBe(
      blindIndex("alice@example.com", indexKey, "users.email")
    );
  });

  it("differs across namespaces, preventing cross-table correlation", () => {
    expect(blindIndex("alice@example.com", indexKey, "users.email")).not.toBe(
      blindIndex("alice@example.com", indexKey, "oauth_accounts.email")
    );
  });

  it("differs across keys (blind index rotates with the data key)", () => {
    expect(blindIndex("x", indexKey, "users.email")).not.toBe(
      blindIndex("x", crypto.randomBytes(32), "users.email")
    );
  });

  it("is a 64-char hex digest", () => {
    expect(blindIndex("x", indexKey, "users.email")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws on empty value or empty namespace", () => {
    expect(() => blindIndex("", indexKey, "users.email")).toThrow(EncryptionError);
    expect(() => blindIndex("x", indexKey, "")).toThrow(EncryptionError);
  });
});