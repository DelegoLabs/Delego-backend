// Issue #55 — Request signing and verification for API auth

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createLogger, json } from "@delegolabs/utils";

const log = createLogger("gateway:request-signing", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SignedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string | Record<string, unknown>;
  timestamp: string;
  nonce: string;
  signature: string;
  keyId: string;
}

export interface SigningKey {
  id: string;
  algorithm: "HMAC-SHA256" | "Ed25519";
  secret: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  scopes: string[];
}

export interface SignatureVerificationResult {
  valid: boolean;
  keyId?: string;
  error?: string;
  timestampValid: boolean;
  nonceValid: boolean;
}

// ---------------------------------------------------------------------------
// Key store (in-memory; swap for DB in production)
// ---------------------------------------------------------------------------

const signingKeys = new Map<string, SigningKey>();
const usedNonces = new Map<string, number>(); // nonce -> expiry timestamp

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes
const NONCE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function registerSigningKey(key: SigningKey): void {
  signingKeys.set(key.id, key);
  log.info("Signing key registered", { keyId: key.id, algorithm: key.algorithm });
}

export function revokeSigningKey(keyId: string): void {
  const key = signingKeys.get(keyId);
  if (key) {
    key.revokedAt = new Date().toISOString();
    log.info("Signing key revoked", { keyId });
  }
}

export function getSigningKey(keyId: string): SigningKey | undefined {
  return signingKeys.get(keyId);
}

// ---------------------------------------------------------------------------
// Signature computation
// ---------------------------------------------------------------------------

export function computeSignature(
  method: string,
  path: string,
  query: Record<string, string>,
  body: string,
  timestamp: string,
  nonce: string,
  secret: string,
): string {
  const sortedQuery = Object.entries(query)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const payload = `${method}\n${path}\n${sortedQuery}\n${timestamp}\n${nonce}\n${body}`;
  return createHmac("sha256", Buffer.from(secret, "base64"))
    .update(payload)
    .digest("base64");
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export function verifySignature(signedReq: SignedRequest): SignatureVerificationResult {
  const key = signingKeys.get(signedReq.keyId);
  if (!key) {
    return { valid: false, error: "Unknown key ID", timestampValid: false, nonceValid: false };
  }

  if (key.revokedAt) {
    return { valid: false, error: "Key has been revoked", timestampValid: false, nonceValid: false };
  }

  if (key.expiresAt && new Date(key.expiresAt) < new Date()) {
    return { valid: false, error: "Key has expired", timestampValid: false, nonceValid: false };
  }

  // Timestamp check
  const requestTime = new Date(signedReq.timestamp).getTime();
  const now = Date.now();
  const timestampValid = !isNaN(requestTime) && Math.abs(now - requestTime) <= TIMESTAMP_TOLERANCE_MS;

  if (!timestampValid) {
    return { valid: false, error: "Timestamp outside tolerance", timestampValid: false, nonceValid: false };
  }

  // Nonce check (replay prevention)
  const nonceExpiry = usedNonces.get(signedReq.nonce);
  const nonceValid = !nonceExpiry || nonceExpiry < now;

  if (!nonceValid) {
    return { valid: false, error: "Nonce already used (replay attack)", timestampValid: true, nonceValid: false };
  }

  // Compute expected signature
  const bodyStr = typeof signedReq.body === "string" ? signedReq.body : JSON.stringify(signedReq.body);
  const expected = computeSignature(
    signedReq.method,
    signedReq.path,
    signedReq.query,
    bodyStr,
    signedReq.timestamp,
    signedReq.nonce,
    key.secret,
  );

  // Timing-safe comparison
  const sigBuf = Buffer.from(signedReq.signature, "base64");
  const expectedBuf = Buffer.from(expected, "base64");

  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return { valid: false, error: "Signature mismatch", timestampValid: true, nonceValid: true };
  }

  // Record nonce
  usedNonces.set(signedReq.nonce, now + NONCE_TTL_MS);

  return { valid: true, keyId: key.id, timestampValid: true, nonceValid: true };
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export function requestSigningMiddleware() {
  return async (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): Promise<void> => {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Only enforce signing on mutating endpoints
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      next();
      return;
    }

    const keyId = req.headers["x-signature-key-id"] as string | undefined;
    const signature = req.headers["x-signature"] as string | undefined;
    const timestamp = req.headers["x-signature-timestamp"] as string | undefined;
    const nonce = req.headers["x-signature-nonce"] as string | undefined;

    if (!keyId || !signature || !timestamp || !nonce) {
      json(res, 401, {
        data: null,
        error: {
          code: "MISSING_SIGNATURE",
          message: "Request signing required: include X-Signature-Key-Id, X-Signature, X-Signature-Timestamp, X-Signature-Nonce headers",
        },
      });
      return;
    }

    // Read body for verification
    let bodyStr = "";
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    bodyStr = Buffer.concat(chunks).toString("utf-8");

    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => { query[k] = v; });

    const result = verifySignature({
      method,
      path: url.pathname,
      query,
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
      body: bodyStr,
      timestamp,
      nonce,
      signature,
      keyId,
    });

    if (!result.valid) {
      log.warn("Signature verification failed", { keyId, error: result.error });
      json(res, 401, {
        data: null,
        error: { code: "INVALID_SIGNATURE", message: result.error ?? "Signature verification failed" },
      });
      return;
    }

    // Re-attach body for downstream handlers
    (req as any)._rawBody = bodyStr;
    next();
  };
}

// ---------------------------------------------------------------------------
// SDK helper for client signing
// ---------------------------------------------------------------------------

export function signRequest(params: {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: string;
  keyId: string;
  secret: string;
}): SignedRequest {
  const timestamp = new Date().toISOString();
  const nonce = randomBytes(16).toString("hex");
  const bodyStr = params.body ?? "";
  const signature = computeSignature(
    params.method,
    params.path,
    params.query ?? {},
    bodyStr,
    timestamp,
    nonce,
    params.secret,
  );

  return {
    method: params.method,
    path: params.path,
    query: params.query ?? {},
    headers: {},
    body: bodyStr,
    timestamp,
    nonce,
    signature,
    keyId: params.keyId,
  };
}

// ---------------------------------------------------------------------------
// Nonce cleanup
// ---------------------------------------------------------------------------

export function cleanupExpiredNonces(): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [nonce, expiry] of usedNonces) {
    if (expiry < now) {
      usedNonces.delete(nonce);
      cleaned++;
    }
  }
  return cleaned;
}

export function resetSigningState(): void {
  signingKeys.clear();
  usedNonces.clear();
}
