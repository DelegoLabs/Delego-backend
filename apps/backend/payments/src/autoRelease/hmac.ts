/**
 * HMAC verification for the delivery-confirmation webhook (Issue #45).
 *
 * The signature is computed as HMAC-SHA256 over the *raw* request body using
 * a shared secret, and delivered via the `X-Signature` header. A common
 * `sha256=<hex>` prefix (as used by GitHub/Stripe-style webhooks) is also
 * accepted so callers don't need to know our exact header format.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("payments:auto-release:hmac", process.env.LOG_LEVEL ?? "info");

export const WEBHOOK_SIGNATURE_HEADER = "x-signature";

function stripSignaturePrefix(signature: string): string {
  const trimmed = signature.trim();
  const eq = trimmed.indexOf("=");
  // Accept "sha256=<hex>" style prefixes; otherwise treat the whole value as hex.
  if (eq > 0 && /^[a-z0-9]+$/i.test(trimmed.slice(0, eq))) {
    return trimmed.slice(eq + 1);
  }
  return trimmed;
}

function computeHmac(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/**
 * Verify an HMAC-SHA256 signature over `rawBody` using `secret`.
 *
 * Uses a timing-safe comparison to avoid leaking information about the
 * expected signature via response-time side channels. Returns `false`
 * (never throws) for malformed input so callers can uniformly respond
 * with 401 Unauthorized.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined | null,
  secret: string
): boolean {
  if (!signatureHeader || !secret) {
    return false;
  }

  const provided = stripSignaturePrefix(signatureHeader);
  const expected = computeHmac(rawBody, secret);

  let providedBuf: Buffer;
  let expectedBuf: Buffer;
  try {
    providedBuf = Buffer.from(provided, "hex");
    expectedBuf = Buffer.from(expected, "hex");
  } catch {
    return false;
  }

  if (providedBuf.length !== expectedBuf.length || providedBuf.length === 0) {
    // timingSafeEqual requires equal-length buffers; a length mismatch is
    // always an invalid signature.
    return false;
  }

  try {
    return timingSafeEqual(providedBuf, expectedBuf);
  } catch (err) {
    log.warn("HMAC comparison failed unexpectedly", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Reads the configured webhook secret, or `null` if not configured. */
export function getWebhookSecret(): string | null {
  return process.env.ESCROW_WEBHOOK_SECRET ?? null;
}
