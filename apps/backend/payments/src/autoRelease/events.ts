/**
 * Domain event emission for the auto-release lifecycle (Issue #45).
 *
 * Emits `release_initiated`, `release_completed`, and `release_failed`
 * events onto the shared `payments:events` stream (via `publishPaymentEvent`)
 * so downstream consumers (notifications, analytics, audit log) can react.
 * Publishing is fire-and-forget: a transport failure is logged but never
 * blocks the release flow itself.
 */

import { createLogger } from "@delegolabs/utils";
import { publishPaymentEvent } from "../../events/index.js";
import type { AutoReleaseEventPayload, AutoReleaseEventType } from "./types.js";

const log = createLogger("payments:auto-release:events", process.env.LOG_LEVEL ?? "info");

export async function emitAutoReleaseEvent(
  type: AutoReleaseEventType,
  orderId: string,
  payload: AutoReleaseEventPayload
): Promise<void> {
  const occurredAt = new Date().toISOString();

  log[type === "release_failed" ? "warn" : "info"](`Auto-release event: ${type}`, { ...payload });

  try {
    await publishPaymentEvent({
      type,
      orderId,
      paymentId: payload.escrowId,
      payload,
      occurredAt,
    });
  } catch (err) {
    log.error("Failed to publish auto-release event", {
      type,
      escrowId: payload.escrowId,
      orderId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
