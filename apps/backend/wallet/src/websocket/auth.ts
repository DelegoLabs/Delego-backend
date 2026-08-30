/**
 * JWT verification helper for WebSocket connections
 * Issue #41
 *
 * Uses Node.js built-in crypto — no extra dependencies.
 * Supports HS256 only (matches the gateway's token format).
 */
import * as crypto from "node:crypto";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("wallet:ws:auth", process.env.LOG_LEVEL ?? "info");

const JWT_SECRET =
  process.env.JWT_SECRET ??
  "dev-jwt-secret-for-websocket-auth-minimum-32-chars";

interface JwtPayload {
  sub?: string;
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}

function base64UrlDecode(input: string): string {
  // Convert base64url to standard base64
  const base64 = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  return Buffer.from(base64, "base64").toString("utf8");
}

function hmacSha256(data: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

/**
 * Verifies a JWT token and returns the decoded payload.
 * Throws on invalid signature, malformed token, or expiry.
 */
export function verifyJwt(token: string): JwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed JWT: expected 3 parts");
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // Verify signature
  const expectedSig = hmacSha256(`${headerB64}.${payloadB64}`, JWT_SECRET);
  const actualSignature = Buffer.from(signatureB64, "base64url");
  const expectedSignature = Buffer.from(expectedSig, "base64url");
  if (
    actualSignature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new Error("JWT signature verification failed");
  }

  // Decode header to verify algorithm
  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(base64UrlDecode(headerB64)) as typeof header;
  } catch {
    throw new Error("Malformed JWT: invalid header");
  }

  if (header.alg && header.alg !== "HS256") {
    throw new Error(`Unsupported JWT algorithm: ${header.alg}`);
  }

  // Decode payload
  let payload: JwtPayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64)) as JwtPayload;
  } catch {
    throw new Error("Malformed JWT: invalid payload");
  }

  // Check expiry
  if (
    payload.exp !== undefined &&
    payload.exp < Math.floor(Date.now() / 1000)
  ) {
    throw new Error("JWT has expired");
  }

  log.debug("JWT verified", { sub: payload.sub });
  return payload;
}

/**
 * Creates a signed HS256 JWT — used only in tests.
 */
export function signJwt(payload: JwtPayload, expiresInSeconds = 3600): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = Buffer.from(
    JSON.stringify({ iat: now, exp: now + expiresInSeconds, ...payload }),
  ).toString("base64url");
  const sig = hmacSha256(`${header}.${fullPayload}`, JWT_SECRET);
  return `${header}.${fullPayload}.${sig}`;
}
