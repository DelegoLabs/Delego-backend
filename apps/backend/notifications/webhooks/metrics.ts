/**
 * Delivery analytics for a webhook (Issue #102).
 */

import type { WebhookDeliveryTracker } from "./deliveryTracker.js";
import type { WebhookMetrics } from "./types.js";

export function computeWebhookMetrics(
  tracker: WebhookDeliveryTracker,
  webhookId: string,
): WebhookMetrics {
  const deliveries = tracker.getDeliveriesForWebhook(webhookId);

  const successful = deliveries.filter((d) => d.status === "delivered");
  const failed = deliveries.filter((d) => d.status === "failed");
  const deadLetter = deliveries.filter((d) => d.status === "dead_letter");

  const latencies = successful
    .filter((d) => d.completedAt)
    .map((d) => new Date(d.completedAt!).getTime() - new Date(d.sentAt).getTime());
  const avgLatencyMs = latencies.length
    ? latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length
    : 0;

  const lastDeliveryAt = deliveries.length
    ? deliveries.reduce((latest, d) => (d.sentAt > latest ? d.sentAt : latest), deliveries[0].sentAt)
    : null;

  return {
    webhookId,
    totalDeliveries: deliveries.length,
    successfulDeliveries: successful.length,
    failedDeliveries: failed.length,
    deadLetterCount: deadLetter.length,
    avgLatencyMs,
    lastDeliveryAt,
  };
}
