/**
 * HMAC signature verification middleware for courier webhooks (Issue #611).
 *
 * Inbound webhook payloads must be authenticated to prevent spoofed delivery
 * status updates. This middleware verifies an HMAC-SHA256 signature from a
 * configurable header against a shared carrier secret, using a timing-safe
 * comparison, and (optionally) rejects requests whose signed timestamp has
 * aged out — bounding the replay window for a captured signature.
 *
 * The raw request body is read here (never re-serialized JSON, since the
 * HMAC must be computed over the exact bytes the sender transmitted) and
 * attached to the request for downstream handlers via `getVerifiedWebhookBody`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createLogger, json } from "@delegolabs/utils";

const log = createLogger("gateway:webhook-auth", process.env.LOG_LEVEL ?? "info");

const DEFAULT_TOLERANCE_SECONDS = 300;
const DEFAULT_BODY_LIMIT_BYTES = 256 * 1024;

export interface HmacVerificationOptions {
  secretKey: string;
  signatureHeaderName: string;
  timestampHeaderName?: string;
  toleranceSeconds?: number;
  /** Maximum accepted request body size in bytes. Defaults to 256 KiB. */
  bodyLimitBytes?: number;
}

export interface HmacVerificationResult {
  valid: boolean;
  reason?: "missing_signature" | "signature_mismatch" | "missing_timestamp" | "timestamp_expired" | "body_too_large" | "body_read_error";
}

const verifiedBodies = new WeakMap<IncomingMessage, Buffer>();

/** The raw bytes verified against the HMAC signature for this request, if the middleware ran. */
export function getVerifiedWebhookBody(req: IncomingMessage): Buffer | undefined {
  return verifiedBodies.get(req);
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

function stripSignaturePrefix(signature: string): string {
  const trimmed = signature.trim().toLowerCase();
  return trimmed.startsWith("sha256=") ? trimmed.slice("sha256=".length) : trimmed;
}

/**
 * Timing-safe HMAC-SHA256 comparison. Both the computed and provided
 * signatures are re-hashed to fixed-size digests first, so the comparison
 * never short-circuits on (or throws because of) the length of an
 * attacker-supplied signature header.
 */
export function verifyHmacSignature(body: Buffer, signatureHeader: string, secretKey: string): boolean {
  const expected = createHmac("sha256", secretKey).update(body).digest("hex");
  const provided = stripSignaturePrefix(signatureHeader);
  const expectedDigest = createHash("sha256").update(expected).digest();
  const providedDigest = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}

/** Parses a signed timestamp header (unix seconds or ISO-8601) into epoch ms, or undefined if unparseable. */
function parseTimestampMs(raw: string): number | undefined {
  if (/^\d+$/.test(raw.trim())) {
    const seconds = Number(raw.trim());
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function readRawBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    req.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > limitBytes) {
        settled = true;
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function fail(res: ServerResponse, code: string, message: string): void {
  json(res, 401, { data: null, error: { code, message } });
}

/**
 * Builds Express/Connect-style middleware that verifies an inbound webhook's
 * HMAC-SHA256 signature before invoking `next()`. Rejects with HTTP 401 on
 * any verification failure (missing/invalid signature, or an expired
 * timestamp when `timestampHeaderName` is configured).
 */
export function webhookAuthMiddleware(options: HmacVerificationOptions) {
  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ): Promise<void> => {
    if (options.timestampHeaderName) {
      const timestampHeader = headerValue(req, options.timestampHeaderName);
      if (!timestampHeader) {
        log.warn("Webhook rejected: missing timestamp header", {
          header: options.timestampHeaderName,
        });
        fail(res, "MISSING_TIMESTAMP", `Missing required header: ${options.timestampHeaderName}`);
        return;
      }

      const timestampMs = parseTimestampMs(timestampHeader);
      if (timestampMs === undefined || Math.abs(Date.now() - timestampMs) > toleranceSeconds * 1000) {
        log.warn("Webhook rejected: timestamp outside tolerance", {
          header: options.timestampHeaderName,
          toleranceSeconds,
        });
        fail(res, "TIMESTAMP_EXPIRED", "Webhook timestamp is missing, malformed, or outside the allowed tolerance");
        return;
      }
    }

    const signatureHeader = headerValue(req, options.signatureHeaderName);
    if (!signatureHeader) {
      log.warn("Webhook rejected: missing signature header", { header: options.signatureHeaderName });
      fail(res, "MISSING_SIGNATURE", `Missing required header: ${options.signatureHeaderName}`);
      return;
    }

    let body: Buffer;
    try {
      body = await readRawBody(req, bodyLimitBytes);
    } catch (err) {
      const tooLarge = err instanceof Error && err.message === "body_too_large";
      log.warn("Webhook rejected: could not read request body", {
        error: err instanceof Error ? err.message : String(err),
      });
      json(res, tooLarge ? 413 : 400, {
        data: null,
        error: {
          code: tooLarge ? "PAYLOAD_TOO_LARGE" : "INVALID_PAYLOAD",
          message: tooLarge ? "Request body exceeds the size limit" : "Could not read request body",
        },
      });
      return;
    }

    if (!verifyHmacSignature(body, signatureHeader, options.secretKey)) {
      log.warn("Webhook rejected: signature mismatch", { header: options.signatureHeaderName });
      fail(res, "INVALID_SIGNATURE", "Invalid webhook signature");
      return;
    }

    verifiedBodies.set(req, body);
    next();
  };
}
