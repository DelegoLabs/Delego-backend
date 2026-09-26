/**
 * HMAC signing for outbound webhook deliveries (Issue #102, #112).
 *
 * Mirrors the verification side in
 * apps/backend/payments/src/autoRelease/hmac.ts (which verifies an
 * *inbound* webhook), but this signs our own *outbound* payloads so
 * receivers can verify authenticity, in the same "sha256=<hex>" style.
 */

import { createHmac } from "node:crypto";

// Issue #112: Changed from X-Webhook-Signature to X-Delego-Signature for webhook signature header
export const WEBHOOK_SIGNATURE_HEADER = "X-Delego-Signature";

/**
 * Webhook payload format for outbound deliveries.
 */
export interface WebhookPayload<T = unknown> {
  id: string; // event id
  event: "order.created" | "escrow.funded" | "escrow.released" | "dispute.opened";
  timestamp: string;
  data: T;
}

/**
 * Sign `rawBody` with `secret`, returning a "sha256=<hex>" signature
 * suitable for the `X-Webhook-Signature` delivery header.
 */
export function signWebhookPayload(rawBody: string, secret: string): string {
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return `sha256=${digest}`;
}
