import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebhookRetryWorker } from "./retryWorker.js";
import { WebhookDispatcher, type WebhookSender } from "./dispatcher.js";
import { WebhookDeliveryTracker } from "./deliveryTracker.js";
import { WebhookRegistry } from "./registry.js";

describe("WebhookRetryWorker", () => {
  let registry: WebhookRegistry;
  let tracker: WebhookDeliveryTracker;

  beforeEach(() => {
    registry = new WebhookRegistry();
    tracker = new WebhookDeliveryTracker();
  });

  it("retries all pending deliveries and reports outcomes", async () => {
    registry.register({
      name: "a",
      url: "https://a.com",
      events: ["order.created"],
      retryPolicy: { maxAttempts: 5 },
    });
    let attempts = 0;
    const sender: WebhookSender = vi.fn(async () => {
      attempts += 1;
      return { status: 500 };
    });
    const dispatcher = new WebhookDispatcher(registry, tracker, sender);
    await dispatcher.dispatch("order.created", {});

    vi.useFakeTimers();
    const [delivery] = tracker.getAllDeliveries();
    vi.setSystemTime(new Date(delivery.nextRetryAt!).getTime() + 1);

    const worker = new WebhookRetryWorker(tracker, dispatcher);
    const result = await worker.processRetries();

    expect(result.retried).toBe(1);
    expect(result.failed).toBe(1);
    expect(attempts).toBe(2);
    vi.useRealTimers();
  });

  it("counts a delivery that exhausts retries as deadLettered, not failed", async () => {
    registry.register({
      name: "a",
      url: "https://a.com",
      events: ["order.created"],
      retryPolicy: { maxAttempts: 1, initialDelayMs: 100, maxDelayMs: 100, backoffMultiplier: 1 },
    });
    const sender: WebhookSender = vi.fn().mockResolvedValue({ status: 500 });
    const dispatcher = new WebhookDispatcher(registry, tracker, sender);
    await dispatcher.dispatch("order.created", {});

    const [delivery] = tracker.getAllDeliveries();
    expect(delivery.status).toBe("dead_letter");

    // Dead-lettered deliveries have no nextRetryAt, so they're never picked
    // up by getPendingRetries again.
    const worker = new WebhookRetryWorker(tracker, dispatcher);
    const result = await worker.processRetries();
    expect(result.retried).toBe(0);
  });

  it("does not retry deliveries whose nextRetryAt is still in the future", async () => {
    registry.register({ name: "a", url: "https://a.com", events: ["order.created"] });
    const sender: WebhookSender = vi.fn().mockResolvedValue({ status: 500 });
    const dispatcher = new WebhookDispatcher(registry, tracker, sender);
    await dispatcher.dispatch("order.created", {});

    const worker = new WebhookRetryWorker(tracker, dispatcher);
    const result = await worker.processRetries(new Date());
    expect(result.retried).toBe(0);
  });
});
