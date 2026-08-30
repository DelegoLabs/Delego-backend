/**
 * Outbound webhook delivery tracking with retry scheduling and a dead
 * letter queue (Issue #102). Follows the same in-memory, injectable-store
 * shape as ../src/deliveryTracker.ts (push notifications).
 */

import { createLogger } from "@delegolabs/utils";
import { randomUUID } from "node:crypto";
import type { RetryPolicy, WebhookDelivery } from "./types.js";

const log = createLogger("notifications:webhooks:deliveryTracker", process.env.LOG_LEVEL ?? "info");

export class WebhookDeliveryTracker {
  private deliveries: Map<string, WebhookDelivery> = new Map();

  recordAttempt(
    webhookId: string,
    eventId: string,
    eventType: string,
    payload: unknown,
    customId?: string,
  ): WebhookDelivery {
    const id = customId ?? randomUUID();
    const now = new Date().toISOString();
    const delivery: WebhookDelivery = {
      id,
      webhookId,
      eventId,
      eventType,
      payload,
      attempt: 1,
      status: "pending",
      sentAt: now,
    };
    this.deliveries.set(id, delivery);
    log.info("Webhook delivery attempt recorded", { id, webhookId, eventType });
    return delivery;
  }

  recordSuccess(id: string, responseStatus: number, responseBody?: string): WebhookDelivery {
    const delivery = this.mustGet(id);
    delivery.status = "delivered";
    delivery.responseStatus = responseStatus;
    delivery.responseBody = responseBody;
    delivery.nextRetryAt = null;
    delivery.completedAt = new Date().toISOString();
    log.info("Webhook delivered", { id, webhookId: delivery.webhookId, responseStatus });
    return delivery;
  }

  /**
   * Record a failed delivery attempt and schedule the next retry per the
   * webhook's retry policy, or move it to the dead letter queue once
   * maxAttempts is reached.
   */
  recordFailure(
    id: string,
    error: string,
    retryPolicy: RetryPolicy,
    responseStatus?: number,
  ): WebhookDelivery {
    const delivery = this.mustGet(id);
    delivery.error = error;
    delivery.responseStatus = responseStatus;

    if (delivery.attempt >= retryPolicy.maxAttempts) {
      delivery.status = "dead_letter";
      delivery.nextRetryAt = null;
      delivery.completedAt = new Date().toISOString();
      log.warn("Webhook delivery moved to dead letter queue", {
        id,
        webhookId: delivery.webhookId,
        attempt: delivery.attempt,
        error,
      });
    } else {
      delivery.status = "failed";
      const backoffMs = Math.min(
        retryPolicy.initialDelayMs * Math.pow(retryPolicy.backoffMultiplier, delivery.attempt - 1),
        retryPolicy.maxDelayMs,
      );
      delivery.nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
      log.info("Webhook delivery failed, scheduled for retry", {
        id,
        webhookId: delivery.webhookId,
        attempt: delivery.attempt,
        nextRetryAt: delivery.nextRetryAt,
      });
    }

    return delivery;
  }

  /** Bump the attempt counter ahead of a retry (called by the retry worker
   * right before re-sending). */
  incrementAttempt(id: string): WebhookDelivery {
    const delivery = this.mustGet(id);
    delivery.attempt += 1;
    delivery.status = "pending";
    return delivery;
  }

  getDelivery(id: string): WebhookDelivery | undefined {
    return this.deliveries.get(id);
  }

  getAllDeliveries(): WebhookDelivery[] {
    return Array.from(this.deliveries.values());
  }

  getPendingRetries(asOf = new Date()): WebhookDelivery[] {
    const nowTime = asOf.getTime();
    return Array.from(this.deliveries.values()).filter((d) => {
      if (d.status !== "failed" || !d.nextRetryAt) return false;
      return new Date(d.nextRetryAt).getTime() <= nowTime;
    });
  }

  getDeadLetterQueue(webhookId?: string): WebhookDelivery[] {
    return Array.from(this.deliveries.values()).filter(
      (d) => d.status === "dead_letter" && (!webhookId || d.webhookId === webhookId),
    );
  }

  getDeliveriesForWebhook(webhookId: string): WebhookDelivery[] {
    return Array.from(this.deliveries.values()).filter((d) => d.webhookId === webhookId);
  }

  clear(): void {
    this.deliveries.clear();
  }

  private mustGet(id: string): WebhookDelivery {
    const delivery = this.deliveries.get(id);
    if (!delivery) {
      throw new Error(`Webhook delivery record not found: ${id}`);
    }
    return delivery;
  }
}

export const defaultWebhookDeliveryTracker = new WebhookDeliveryTracker();
