import { describe, it, expect } from "vitest";
import { computeWebhookMetrics } from "./metrics.js";
import { WebhookDeliveryTracker } from "./deliveryTracker.js";
import { DEFAULT_RETRY_POLICY } from "./types.js";

describe("computeWebhookMetrics", () => {
  it("returns zeroed metrics for a webhook with no deliveries", () => {
    const tracker = new WebhookDeliveryTracker();
    const metrics = computeWebhookMetrics(tracker, "wh-none");
    expect(metrics.totalDeliveries).toBe(0);
    expect(metrics.lastDeliveryAt).toBeNull();
    expect(metrics.avgLatencyMs).toBe(0);
  });

  it("counts delivered, failed, and dead-lettered deliveries separately", () => {
    const tracker = new WebhookDeliveryTracker();

    const ok = tracker.recordAttempt("wh-1", "e1", "order.created", {});
    tracker.recordSuccess(ok.id, 200);

    const failing = tracker.recordAttempt("wh-1", "e2", "order.created", {});
    tracker.recordFailure(failing.id, "err", DEFAULT_RETRY_POLICY);

    const dead = tracker.recordAttempt("wh-1", "e3", "order.created", {});
    tracker.recordFailure(dead.id, "err", { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1 });

    const metrics = computeWebhookMetrics(tracker, "wh-1");
    expect(metrics.totalDeliveries).toBe(3);
    expect(metrics.successfulDeliveries).toBe(1);
    expect(metrics.failedDeliveries).toBe(1);
    expect(metrics.deadLetterCount).toBe(1);
  });

  it("only includes deliveries for the requested webhookId", () => {
    const tracker = new WebhookDeliveryTracker();
    const forA = tracker.recordAttempt("wh-a", "e1", "order.created", {});
    tracker.recordSuccess(forA.id, 200);
    tracker.recordAttempt("wh-b", "e2", "order.created", {});

    const metrics = computeWebhookMetrics(tracker, "wh-a");
    expect(metrics.totalDeliveries).toBe(1);
  });

  it("computes average latency across successful deliveries", () => {
    const tracker = new WebhookDeliveryTracker();
    const d1 = tracker.recordAttempt("wh-1", "e1", "order.created", {});
    tracker.recordSuccess(d1.id, 200);

    const metrics = computeWebhookMetrics(tracker, "wh-1");
    expect(metrics.avgLatencyMs).toBeGreaterThanOrEqual(0);
  });
});
