import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebhookDeliveryTracker } from "./deliveryTracker.js";
import { DEFAULT_RETRY_POLICY } from "./types.js";

describe("WebhookDeliveryTracker", () => {
  let tracker: WebhookDeliveryTracker;

  beforeEach(() => {
    tracker = new WebhookDeliveryTracker();
  });

  it("records a new delivery attempt as pending", () => {
    const delivery = tracker.recordAttempt("wh-1", "evt-1", "order.created", { id: 1 });
    expect(delivery.status).toBe("pending");
    expect(delivery.attempt).toBe(1);
  });

  it("marks a delivery as delivered on success", () => {
    const delivery = tracker.recordAttempt("wh-1", "evt-1", "order.created", {});
    const updated = tracker.recordSuccess(delivery.id, 200, "ok");
    expect(updated.status).toBe("delivered");
    expect(updated.responseStatus).toBe(200);
    expect(updated.completedAt).toBeDefined();
  });

  it("schedules a retry on failure when attempts remain", () => {
    const delivery = tracker.recordAttempt("wh-1", "evt-1", "order.created", {});
    const updated = tracker.recordFailure(delivery.id, "timeout", DEFAULT_RETRY_POLICY);
    expect(updated.status).toBe("failed");
    expect(updated.nextRetryAt).toBeTruthy();
  });

  it("moves a delivery to the dead letter queue once maxAttempts is reached", () => {
    const delivery = tracker.recordAttempt("wh-1", "evt-1", "order.created", {});
    for (let i = 0; i < DEFAULT_RETRY_POLICY.maxAttempts - 1; i++) {
      tracker.incrementAttempt(delivery.id);
    }
    const updated = tracker.recordFailure(delivery.id, "still failing", DEFAULT_RETRY_POLICY);
    expect(updated.status).toBe("dead_letter");
    expect(updated.nextRetryAt).toBeNull();
  });

  it("applies exponential backoff capped at maxDelayMs", () => {
    const policy = { maxAttempts: 10, initialDelayMs: 1000, maxDelayMs: 5000, backoffMultiplier: 2 };
    const delivery = tracker.recordAttempt("wh-1", "evt-1", "e", {});
    for (let i = 0; i < 5; i++) tracker.incrementAttempt(delivery.id);

    const before = Date.now();
    const updated = tracker.recordFailure(delivery.id, "err", policy);
    const delayMs = new Date(updated.nextRetryAt!).getTime() - before;
    expect(delayMs).toBeLessThanOrEqual(policy.maxDelayMs + 50);
  });

  it("getPendingRetries only returns failed deliveries whose nextRetryAt has passed", () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(now);

    const d1 = tracker.recordAttempt("wh-1", "evt-1", "e", {});
    tracker.recordFailure(d1.id, "err", { maxAttempts: 5, initialDelayMs: 1000, maxDelayMs: 60000, backoffMultiplier: 2 });

    expect(tracker.getPendingRetries(now)).toHaveLength(0);

    const later = new Date(now.getTime() + 2000);
    expect(tracker.getPendingRetries(later)).toHaveLength(1);
    vi.useRealTimers();
  });

  it("getDeadLetterQueue filters by webhookId when given", () => {
    const d1 = tracker.recordAttempt("wh-1", "evt-1", "e", {});
    const d2 = tracker.recordAttempt("wh-2", "evt-2", "e", {});
    const oneAttempt = { maxAttempts: 1, initialDelayMs: 1000, maxDelayMs: 1000, backoffMultiplier: 1 };
    tracker.recordFailure(d1.id, "err", oneAttempt);
    tracker.recordFailure(d2.id, "err", oneAttempt);

    expect(tracker.getDeadLetterQueue()).toHaveLength(2);
    expect(tracker.getDeadLetterQueue("wh-1")).toHaveLength(1);
  });

  it("throws when acting on an unknown delivery id", () => {
    expect(() => tracker.recordSuccess("nonexistent", 200)).toThrow(/not found/);
  });
});
