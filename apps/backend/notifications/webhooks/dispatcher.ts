/**
 * Outbound webhook event dispatch (Issue #102).
 *
 * Fans an event out to every active, matching webhook subscriber, signs
 * each payload, and records the delivery outcome via the tracker. The HTTP
 * transport is injected so this stays unit-testable without a real network
 * call, matching the sender-injection pattern in ../src/retryWorker.ts.
 */

import { createLogger } from "@delegolabs/utils";
import { randomUUID } from "node:crypto";
import { signWebhookPayload, WEBHOOK_SIGNATURE_HEADER } from "./hmac.js";
import type { WebhookDeliveryTracker } from "./deliveryTracker.js";
import type { WebhookRegistry } from "./registry.js";
import type { Webhook } from "./types.js";

const log = createLogger("notifications:webhooks:dispatcher", process.env.LOG_LEVEL ?? "info");

export interface WebhookSendResult {
  status: number;
  body?: string;
}

export type WebhookSender = (
  webhook: Webhook,
  body: string,
  headers: Record<string, string>,
) => Promise<WebhookSendResult>;

export interface DispatchSummary {
  eventId: string;
  eventType: string;
  matchedWebhooks: number;
  delivered: number;
  failed: number;
}

export class WebhookDispatcher {
  constructor(
    private registry: WebhookRegistry,
    private tracker: WebhookDeliveryTracker,
    private sender: WebhookSender,
  ) {}

  /**
   * Dispatch `eventType`/`payload` to every active webhook subscribed to it
   * whose filters match. Each delivery is attempted once here; failures are
   * left in the tracker as "failed" (with a scheduled nextRetryAt) for the
   * retry worker to pick up.
   */
  async dispatch(
    eventType: string,
    payload: Record<string, unknown>,
    eventId = randomUUID(),
  ): Promise<DispatchSummary> {
    const subscribers = this.registry.findSubscribers(eventType, payload);
    let delivered = 0;
    let failed = 0;

    for (const webhook of subscribers) {
      const ok = await this.deliverOnce(webhook, eventType, payload, eventId);
      if (ok) delivered += 1;
      else failed += 1;
    }

    log.info("Webhook event dispatched", {
      eventId,
      eventType,
      matchedWebhooks: subscribers.length,
      delivered,
      failed,
    });

    return { eventId, eventType, matchedWebhooks: subscribers.length, delivered, failed };
  }

  /** Re-attempt a previously failed delivery (used by the retry worker). */
  async retry(deliveryId: string): Promise<boolean> {
    const delivery = this.tracker.getDelivery(deliveryId);
    if (!delivery) {
      throw new Error(`Webhook delivery record not found: ${deliveryId}`);
    }
    const webhook = this.registry.get(delivery.webhookId);
    if (!webhook) {
      throw new Error(`Webhook not found: ${delivery.webhookId}`);
    }

    this.tracker.incrementAttempt(deliveryId);
    return this.send(webhook, delivery.eventType, delivery.payload as Record<string, unknown>, deliveryId);
  }

  private async deliverOnce(
    webhook: Webhook,
    eventType: string,
    payload: Record<string, unknown>,
    eventId: string,
  ): Promise<boolean> {
    const delivery = this.tracker.recordAttempt(webhook.id, eventId, eventType, payload);
    return this.send(webhook, eventType, payload, delivery.id);
  }

  private async send(
    webhook: Webhook,
    eventType: string,
    payload: Record<string, unknown>,
    deliveryId: string,
  ): Promise<boolean> {
    const body = JSON.stringify({ eventId: deliveryId, eventType, data: payload });
    const headers = {
      "Content-Type": "application/json",
      [WEBHOOK_SIGNATURE_HEADER]: signWebhookPayload(body, webhook.secret),
      "X-Webhook-Id": webhook.id,
      "X-Webhook-Version": String(webhook.version),
      ...webhook.headers,
    };

    try {
      const result = await this.sender(webhook, body, headers);
      if (result.status >= 200 && result.status < 300) {
        this.tracker.recordSuccess(deliveryId, result.status, result.body);
        return true;
      }
      this.tracker.recordFailure(
        deliveryId,
        `Non-2xx response: ${result.status}`,
        webhook.retryPolicy,
        result.status,
      );
      return false;
    } catch (err) {
      this.tracker.recordFailure(
        deliveryId,
        err instanceof Error ? err.message : String(err),
        webhook.retryPolicy,
      );
      return false;
    }
  }
}
