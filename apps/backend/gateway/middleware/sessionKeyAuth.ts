/**
 * Session Key Authentication Middleware (Issue #TBD)
 *
 * Validates cryptographic signatures from autonomous buyer agents using
 * delegated ephemeral Ed25519 keys. This middleware:
 * 
 * 1. Verifies Ed25519 signature of request payload against sessionPublicKey
 * 2. Confirms session key is active and unexpired (TODO: database check)
 * 3. Verifies spending allowance limits (TODO: Redis check)
 * 
 * This file implements step 1: Ed25519 signature verification (1% complete).
 */

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

/**
 * Session key authentication header structure sent by autonomous agents.
 */
export interface SessionKeyAuthHeader {
  /** Ed25519 public key (hex or base64 encoded) */
  sessionPublicKey: string;
  /** Stellar address of the delegator who authorized this session key */
  delegatorAddress: string;
  /** Ed25519 signature of the request payload (hex or base64 encoded) */
  signature: string;
  /** Unix timestamp in milliseconds when the request was signed */
  timestamp: number;
  /** Unique nonce to prevent replay attacks */
  nonce: string;
}

/**
 * Result of Ed25519 signature verification.
 */
export interface SignatureVerificationResult {
  valid: boolean;
  error?: string;
}

/**
 * Verifies an Ed25519 signature against a payload and public key.
 * 
 * @param payload - The raw request payload (typically JSON stringified body)
 * @param signature - The Ed25519 signature (hex or base64 encoded)
 * @param publicKey - The Ed25519 public key (hex or base64 encoded)
 * @returns Verification result with validity status and optional error message
 * 
 * @example
 * ```typescript
 * const payload = JSON.stringify({ orderId: "123", amount: 1000 });
 * const result = verifyEd25519Signature(payload, signature, publicKey);
 * if (!result.valid) {
 *   console.error("Signature verification failed:", result.error);
 * }
 * ```
 */
export function verifyEd25519Signature(
  payload: string,
  signature: string,
  publicKey: string
): SignatureVerificationResult {
  try {
    // Normalize inputs - support both hex and base64 encoding
    const publicKeyBuffer = Buffer.from(publicKey, isHexEncoded(publicKey) ? "hex" : "base64");
    const signatureBuffer = Buffer.from(signature, isHexEncoded(signature) ? "hex" : "base64");

    // Ed25519 public keys are 32 bytes
    if (publicKeyBuffer.length !== 32) {
      return {
        valid: false,
        error: `Invalid Ed25519 public key length: expected 32 bytes, got ${publicKeyBuffer.length}`,
      };
    }

    // Ed25519 signatures are 64 bytes
    if (signatureBuffer.length !== 64) {
      return {
        valid: false,
        error: `Invalid Ed25519 signature length: expected 64 bytes, got ${signatureBuffer.length}`,
      };
    }

    // Convert raw Ed25519 public key to PEM format for Node.js crypto
    const publicKeyPem = createEd25519PublicKeyPem(publicKeyBuffer);
    
    // Create a KeyObject from the PEM
    const publicKeyObject = createPublicKey({
      key: publicKeyPem,
      format: "pem",
      type: "spki",
    });
    
    // Verify the signature using Node.js crypto.verify
    const isValid = cryptoVerify(
      null, // Ed25519 doesn't use a separate hash algorithm
      Buffer.from(payload, "utf-8"),
      publicKeyObject,
      signatureBuffer
    );

    return { valid: isValid };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Unknown verification error",
    };
  }
}

/**
 * Checks if a string is hex-encoded (only contains 0-9, a-f, A-F).
 */
function isHexEncoded(str: string): boolean {
  return /^[0-9a-fA-F]+$/.test(str) && str.length % 2 === 0;
}

/**
 * Creates a PEM-formatted Ed25519 public key from raw 32-byte key material.
 * Uses SubjectPublicKeyInfo (SPKI) format as required by Node.js crypto.
 * 
 * @param rawPublicKey - 32-byte Ed25519 public key
 * @returns PEM-formatted public key string
 */
function createEd25519PublicKeyPem(rawPublicKey: Buffer): string {
  // Ed25519 OID: 1.3.101.112
  // SPKI header for Ed25519:
  // SEQUENCE (48 bytes)
  //   SEQUENCE (algorithm identifier)
  //     OID 1.3.101.112 (Ed25519)
  //   BIT STRING (public key)
  
  const oid = Buffer.from([0x06, 0x03, 0x2b, 0x65, 0x70]); // OID for Ed25519
  const algorithmIdentifier = Buffer.concat([
    Buffer.from([0x30, 0x05]), // SEQUENCE, length 5
    oid,
  ]);
  
  const publicKeyBitString = Buffer.concat([
    Buffer.from([0x03, 0x21, 0x00]), // BIT STRING, length 33, no unused bits
    rawPublicKey,
  ]);
  
  const spki = Buffer.concat([
    Buffer.from([0x30, 0x2a]), // SEQUENCE, length 42
    algorithmIdentifier,
    publicKeyBitString,
  ]);

  // Convert to PEM format
  const base64 = spki.toString("base64");
  return `-----BEGIN PUBLIC KEY-----\n${base64}\n-----END PUBLIC KEY-----\n`;
}

/**
 * Computes a SHA-256 hash of the payload for use in signatures.
 * This is used to create a deterministic digest of request data.
 * 
 * @param payload - The data to hash
 * @returns Hex-encoded SHA-256 hash
 */
export function hashPayload(payload: string): string {
  return createHash("sha256").update(payload, "utf-8").digest("hex");
}

/**
 * Parses and validates the session key auth header from request headers.
 * Expected format: "SessionKey <base64-encoded-json>"
 * 
 * @param authHeader - The Authorization header value
 * @returns Parsed session key auth header or null if invalid
 */
export function parseSessionKeyAuthHeader(authHeader: string | undefined): SessionKeyAuthHeader | null {
  if (!authHeader || !authHeader.startsWith("SessionKey ")) {
    return null;
  }

  try {
    const encodedPayload = authHeader.slice(11); // Remove "SessionKey " prefix
    const jsonPayload = Buffer.from(encodedPayload, "base64").toString("utf-8");
    const parsed = JSON.parse(jsonPayload) as Partial<SessionKeyAuthHeader>;

    // Validate required fields
    if (
      !parsed.sessionPublicKey ||
      !parsed.delegatorAddress ||
      !parsed.signature ||
      typeof parsed.timestamp !== "number" ||
      !parsed.nonce
    ) {
      return null;
    }

    return parsed as SessionKeyAuthHeader;
  } catch {
    return null;
  }
}
