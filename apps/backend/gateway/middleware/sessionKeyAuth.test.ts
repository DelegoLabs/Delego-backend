/**
 * Unit tests for Session Key Authentication Middleware
 * Tests Ed25519 signature verification (1% of the feature)
 */

import { describe, it, expect } from "vitest";
import {
  verifyEd25519Signature,
  hashPayload,
  parseSessionKeyAuthHeader,
  type SessionKeyAuthHeader,
} from "./sessionKeyAuth.js";
import { generateKeyPairSync, sign } from "node:crypto";

describe("Session Key Authentication", () => {
  describe("verifyEd25519Signature", () => {
    it("verifies a valid Ed25519 signature", () => {
      // Generate a test Ed25519 key pair
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");

      const payload = JSON.stringify({ orderId: "test-123", amount: 5000 });

      // Sign the payload
      const signature = sign(null, Buffer.from(payload), privateKey);

      // Extract raw public key (32 bytes)
      const rawPublicKey = publicKey.export({ type: "spki", format: "der" }).subarray(-32);

      // Verify the signature
      const result = verifyEd25519Signature(
        payload,
        signature.toString("hex"),
        rawPublicKey.toString("hex")
      );

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("rejects an invalid signature", () => {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");

      const payload = JSON.stringify({ orderId: "test-123", amount: 5000 });
      const tamperedPayload = JSON.stringify({ orderId: "test-123", amount: 9999 });

      // Sign the original payload
      const signature = sign(null, Buffer.from(payload), privateKey);

      // Extract raw public key
      const rawPublicKey = publicKey.export({ type: "spki", format: "der" }).subarray(-32);

      // Try to verify with tampered payload
      const result = verifyEd25519Signature(
        tamperedPayload,
        signature.toString("hex"),
        rawPublicKey.toString("hex")
      );

      expect(result.valid).toBe(false);
    });

    it("rejects signature with wrong public key", () => {
      const { privateKey: privateKey1 } = generateKeyPairSync("ed25519");
      const { publicKey: publicKey2 } = generateKeyPairSync("ed25519");

      const payload = JSON.stringify({ orderId: "test-123", amount: 5000 });

      // Sign with key 1
      const signature = sign(null, Buffer.from(payload), privateKey1);

      // Try to verify with key 2
      const rawPublicKey2 = publicKey2.export({ type: "spki", format: "der" }).subarray(-32);

      const result = verifyEd25519Signature(
        payload,
        signature.toString("hex"),
        rawPublicKey2.toString("hex")
      );

      expect(result.valid).toBe(false);
    });

    it("handles base64-encoded keys and signatures", () => {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");

      const payload = JSON.stringify({ orderId: "test-456", amount: 2500 });
      const signature = sign(null, Buffer.from(payload), privateKey);
      const rawPublicKey = publicKey.export({ type: "spki", format: "der" }).subarray(-32);

      // Verify with base64 encoding
      const result = verifyEd25519Signature(
        payload,
        signature.toString("base64"),
        rawPublicKey.toString("base64")
      );

      expect(result.valid).toBe(true);
    });

    it("rejects invalid public key length", () => {
      const payload = JSON.stringify({ orderId: "test-789" });
      const invalidPublicKey = Buffer.from("tooshort").toString("hex");
      const fakeSignature = Buffer.alloc(64).toString("hex");

      const result = verifyEd25519Signature(payload, fakeSignature, invalidPublicKey);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid Ed25519 public key length");
    });

    it("rejects invalid signature length", () => {
      const payload = JSON.stringify({ orderId: "test-101" });
      const { publicKey } = generateKeyPairSync("ed25519");
      const rawPublicKey = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
      const invalidSignature = Buffer.from("tooshort").toString("hex");

      const result = verifyEd25519Signature(
        payload,
        invalidSignature,
        rawPublicKey.toString("hex")
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid Ed25519 signature length");
    });
  });

  describe("hashPayload", () => {
    it("produces consistent SHA-256 hash", () => {
      const payload = JSON.stringify({ test: "data" });
      const hash1 = hashPayload(payload);
      const hash2 = hashPayload(payload);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 is 32 bytes = 64 hex chars
    });

    it("produces different hashes for different payloads", () => {
      const hash1 = hashPayload("payload1");
      const hash2 = hashPayload("payload2");

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("parseSessionKeyAuthHeader", () => {
    it("parses valid SessionKey header", () => {
      const authData: SessionKeyAuthHeader = {
        sessionPublicKey: "abcd1234".repeat(8), // 64 hex chars
        delegatorAddress: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        signature: "ef567890".repeat(16), // 128 hex chars
        timestamp: Date.now(),
        nonce: "random-nonce-123",
      };

      const encodedPayload = Buffer.from(JSON.stringify(authData)).toString("base64");
      const authHeader = `SessionKey ${encodedPayload}`;

      const parsed = parseSessionKeyAuthHeader(authHeader);

      expect(parsed).not.toBeNull();
      expect(parsed?.sessionPublicKey).toBe(authData.sessionPublicKey);
      expect(parsed?.delegatorAddress).toBe(authData.delegatorAddress);
      expect(parsed?.timestamp).toBe(authData.timestamp);
      expect(parsed?.nonce).toBe(authData.nonce);
    });

    it("returns null for missing SessionKey prefix", () => {
      const authData = { sessionPublicKey: "test" };
      const encodedPayload = Buffer.from(JSON.stringify(authData)).toString("base64");
      const authHeader = `Bearer ${encodedPayload}`;

      const parsed = parseSessionKeyAuthHeader(authHeader);

      expect(parsed).toBeNull();
    });

    it("returns null for invalid JSON", () => {
      const authHeader = "SessionKey invalid-base64!@#";

      const parsed = parseSessionKeyAuthHeader(authHeader);

      expect(parsed).toBeNull();
    });

    it("returns null for missing required fields", () => {
      const incompleteData = {
        sessionPublicKey: "test",
        // missing other required fields
      };

      const encodedPayload = Buffer.from(JSON.stringify(incompleteData)).toString("base64");
      const authHeader = `SessionKey ${encodedPayload}`;

      const parsed = parseSessionKeyAuthHeader(authHeader);

      expect(parsed).toBeNull();
    });

    it("returns null for undefined header", () => {
      const parsed = parseSessionKeyAuthHeader(undefined);

      expect(parsed).toBeNull();
    });
  });
});
