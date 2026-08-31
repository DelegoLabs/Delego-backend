/**
 * Domain event emission for the subscription lifecycle (Issue #47).
 * Published on the shared `payments:events` stream, same transport used by
 * the rest of the payment lifecycle events. Fire-and-forget: a transport
 * failure is logged but never blocks the billing flow.
 */

import { createLogger } from "@delegolabs/utils";
import { publishPaymentEvent } from "../../events/index.js";
import type { SubscriptionEvent } from "./types.js";

const log = createLogger("payments:subscriptions:notifications", process.env.LOG_LEVEL ?? "info");

export async function emitSubscriptionEvent(event: SubscriptionEvent): Promise<void> {
  log[event.type === "payment_failed" ? "warn" : "info"](`Subscription event: ${event.type}`, {
    subscriptionId: event.subscriptionId,
    ...event.data,
  });

  try {
    await publishPaymentEvent({
      type: event.type,
      orderId: event.subscriptionId,
      payload: event.data,
      occurredAt: event.timestamp,
    });
  } catch (err) {
    log.error("Failed to publish subscription event", {
      type: event.type,
      subscriptionId: event.subscriptionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function subscriptionEvent(
  subscriptionId: string,
  type: SubscriptionEvent["type"],
  data: Record<string, unknown> = {}
): SubscriptionEvent {
  return { subscriptionId, type, timestamp: new Date().toISOString(), data };
}
