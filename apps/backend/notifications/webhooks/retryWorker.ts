/**
 * Retry worker for pending webhook deliveries (Issue #102). Mirrors
 * ../src/retryWorker.ts (push notifications).
 */

import { createLogger } from "@delegolabs/utils";
import type { WebhookDeliveryTracker } from "./deliveryTracker.js";
import type { WebhookDispatcher } from "./dispatcher.js";

const log = createLogger("notifications:webhooks:retryWorker", process.env.LOG_LEVEL ?? "info");

export interface WebhookRetryBatchResult {
  retried: number;
  succeeded: number;
  failed: number;
  deadLettered: number;
}

export class WebhookRetryWorker {
  constructor(
    private tracker: WebhookDeliveryTracker,
    private dispatcher: WebhookDispatcher,
  ) {}

  async processRetries(asOf = new Date()): Promise<WebhookRetryBatchResult> {
    const pending = this.tracker.getPendingRetries(asOf);
    log.info("Processing pending webhook retries", { count: pending.length });

    let succeeded = 0;
    let failed = 0;
    let deadLettered = 0;

    for (const delivery of pending) {
      const ok = await this.dispatcher.retry(delivery.id);
      if (ok) {
        succeeded += 1;
      } else {
        const updated = this.tracker.getDelivery(delivery.id);
        if (updated?.status === "dead_letter") {
          deadLettered += 1;
        } else {
          failed += 1;
        }
      }
    }

    return { retried: pending.length, succeeded, failed, deadLettered };
  }
}
