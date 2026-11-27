/**
 * Session Key Authentication Middleware (Issue #788)
 *
 * Validates cryptographic signatures from autonomous buyer agents using
 * delegated ephemeral Ed25519 keys. This middleware:
 * 
 * 1. Verifies Ed25519 signature of request payload against sessionPublicKey
 * 2. Confirms session key is active and unexpired in PostgreSQL.
 * 3. Enforces per-session spending limits and nonce replay protection in Redis.
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


/** PostgreSQL row required to authorize a delegated session key. */
export interface SessionKeyAuthRecord {
  revoked: boolean;
  expires_at: Date | string;
  spending_limit_stroops: string;
  spent_amount_stroops: string;
  max_per_call_stroops: string;
}

export interface SessionKeyAuthDatabase {
  query<T = SessionKeyAuthRecord>(
    sql: string,
    values: unknown[]
  ): Promise<{ rows: T[] }>;
}

export interface SessionKeyAuthRedis {
  set(key: string, value: string, ...args: Array<string | number>): Promise<string | null>;
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<number>;
}

export interface SessionKeyAuthDependencies {
  database: SessionKeyAuthDatabase;
  redis: SessionKeyAuthRedis;
  /** Current time in milliseconds; injectable for deterministic tests. */
  now?: () => number;
  timestampToleranceMs?: number;
  nonceTtlSeconds?: number;
}

export interface SessionKeyAuthRequest {
  payload: string;
  requestedAmountStroops: string;
  authHeader: string | undefined;
}

export type SessionKeyAuthFailure =
  | "MISSING_OR_INVALID_HEADER"
  | "INVALID_SIGNATURE"
  | "STALE_TIMESTAMP"
  | "SESSION_KEY_NOT_FOUND"
  | "SESSION_KEY_REVOKED"
  | "SESSION_KEY_EXPIRED"
  | "INVALID_AMOUNT"
  | "PER_CALL_ALLOWANCE_EXCEEDED"
  | "SESSION_ALLOWANCE_EXCEEDED"
  | "NONCE_REPLAYED";

export type SessionKeyAuthResult =
  | { authorized: true; session: SessionKeyAuthRecord; header: SessionKeyAuthHeader }
  | { authorized: false; reason: SessionKeyAuthFailure };

/**
 * Atomically reserves an amount against a session's Redis allowance.
 *
 * The Lua script uses decimal-string arithmetic rather than Lua numbers:
 * Stellar stroops can exceed IEEE-754's exact integer range.
 */
export const RESERVE_SESSION_ALLOWANCE_SCRIPT = `
local function norm(value)
  value = string.gsub(value, "^0+", "")
  if value == "" then return "0" end
  return value
end
local function greater(a, b)
  a = norm(a); b = norm(b)
  if string.len(a) ~= string.len(b) then
    return string.len(a) > string.len(b)
  end
  return a > b
end
local function add(a, b)
  a = norm(a); b = norm(b)
  local i = string.len(a)
  local j = string.len(b)
  local carry = 0
  local out = ""
  while i > 0 or j > 0 or carry > 0 do
    local da = i > 0 and tonumber(string.sub(a, i, i)) or 0
    local db = j > 0 and tonumber(string.sub(b, j, j)) or 0
    local sum = da + db + carry
    out = tostring(sum % 10) .. out
    carry = math.floor(sum / 10)
    i = i - 1; j = j - 1
  end
  return norm(out)
end
local current = redis.call("GET", KEYS[1])
if not current then current = ARGV[1] end
local nextValue = add(current, ARGV[2])
if greater(nextValue, ARGV[3]) then return -1 end
redis.call("SET", KEYS[1], nextValue, "EX", ARGV[4])
return 1
`;

/**
 * Authenticates a signed session-key request and enforces its persisted
 * status, per-call/total allowance, and one-time nonce.
 *
 * The caller must pass the exact raw payload that was signed and the
 * requested amount in stroops. Signature verification deliberately runs
 * before database/Redis lookups so unauthenticated callers cannot probe
 * session state.
 */
export async function authenticateSessionKeyRequest(
  request: SessionKeyAuthRequest,
  dependencies: SessionKeyAuthDependencies
): Promise<SessionKeyAuthResult> {
  const header = parseSessionKeyAuthHeader(request.authHeader);
  if (!header) return { authorized: false, reason: "MISSING_OR_INVALID_HEADER" };

  if (!verifyEd25519Signature(request.payload, header.signature, header.sessionPublicKey).valid) {
    return { authorized: false, reason: "INVALID_SIGNATURE" };
  }

  const now = (dependencies.now ?? Date.now)();
  const tolerance = dependencies.timestampToleranceMs ?? 5 * 60 * 1000;
  if (!Number.isFinite(header.timestamp) || Math.abs(now - header.timestamp) > tolerance) {
    return { authorized: false, reason: "STALE_TIMESTAMP" };
  }

  const amount = request.requestedAmountStroops;
  if (!/^[0-9]+$/.test(amount) || /^0+$/.test(amount)) {
    return { authorized: false, reason: "INVALID_AMOUNT" };
  }

  const result = await dependencies.database.query<SessionKeyAuthRecord>(
    `SELECT revoked, expires_at, spending_limit_stroops,
            spent_amount_stroops, max_per_call_stroops
       FROM session_keys
      WHERE session_public_key = $1
      LIMIT 1`,
    [header.sessionPublicKey]
  );
  const session = result.rows[0];
  if (!session) return { authorized: false, reason: "SESSION_KEY_NOT_FOUND" };
  if (session.revoked) return { authorized: false, reason: "SESSION_KEY_REVOKED" };

  const expiresAt = new Date(session.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return { authorized: false, reason: "SESSION_KEY_EXPIRED" };
  }

  if (
    !/^[0-9]+$/.test(session.spending_limit_stroops) ||
    !/^[0-9]+$/.test(session.spent_amount_stroops) ||
    !/^[0-9]+$/.test(session.max_per_call_stroops)
  ) {
    return { authorized: false, reason: "INVALID_AMOUNT" };
  }
  if (BigInt(amount) > BigInt(session.max_per_call_stroops)) {
    return { authorized: false, reason: "PER_CALL_ALLOWANCE_EXCEEDED" };
  }

  // Claim the nonce only after the signature and persisted session checks.
  // The namespace includes the public key so separate sessions cannot collide.
  const nonceTtl = dependencies.nonceTtlSeconds ?? 600;
  const nonceKey = `session-key:nonce:${header.sessionPublicKey}:${header.nonce}`;
  const claimed = await dependencies.redis.set(nonceKey, "1", "EX", nonceTtl, "NX");
  if (claimed !== "OK") return { authorized: false, reason: "NONCE_REPLAYED" };

  const remainingTtl = Math.max(1, Math.ceil((expiresAt - now) / 1000));
  const allowanceResult = await dependencies.redis.eval(
    RESERVE_SESSION_ALLOWANCE_SCRIPT,
    1,
    `session-key:allowance:${header.sessionPublicKey}`,
    session.spent_amount_stroops,
    amount,
    session.spending_limit_stroops,
    remainingTtl
  );
  if (allowanceResult !== 1) {
    return { authorized: false, reason: "SESSION_ALLOWANCE_EXCEEDED" };
  }

  return { authorized: true, session, header };
}
