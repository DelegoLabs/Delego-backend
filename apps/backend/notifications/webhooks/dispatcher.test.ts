import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebhookDispatcher, type WebhookSender } from "./dispatcher.js";
import { WebhookDeliveryTracker } from "./deliveryTracker.js";
import { WebhookRegistry } from "./registry.js";
import { WEBHOOK_SIGNATURE_HEADER } from "./hmac.js";

describe("WebhookDispatcher", () => {
  let registry: WebhookRegistry;
  let tracker: WebhookDeliveryTracker;

  beforeEach(() => {
    registry = new WebhookRegistry();
    tracker = new WebhookDeliveryTracker();
  });

  it("delivers to every active subscriber and records success", async () => {
    registry.register({ name: "a", url: "https://a.com", events: ["order.created"] });
    registry.register({ name: "b", url: "https://b.com", events: ["order.created"] });
    const sender: WebhookSender = vi.fn().mockResolvedValue({ status: 200, body: "ok" });
    const dispatcher = new WebhookDispatcher(registry, tracker, sender);

    const summary = await dispatcher.dispatch("order.created", { id: 1 });

    expect(summary.matchedWebhooks).toBe(2);
    expect(summary.delivered).toBe(2);
    expect(summary.failed).toBe(0);
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it("signs the payload and includes webhook identity headers", async () => {
    const webhook = registry.register({ name: "a", url: "https://a.com", events: ["order.created"] });
    let capturedHeaders: Record<string, string> = {};
    const sender: WebhookSender = vi.fn(async (_wh, _body, headers) => {
      capturedHeaders = headers;
      return { status: 200 };
    });
    const dispatcher = new WebhookDispatcher(registry, tracker, sender);

    await dispatcher.dispatch("order.created", { id: 1 });

    expect(capturedHeaders[WEBHOOK_SIGNATURE_HEADER]).toMatch(/^sha256=/);
    expect(capturedHeaders["X-Webhook-Id"]).toBe(webhook.id);
    expect(capturedHeaders["X-Webhook-Version"]).toBe("1");
  });

  it("records a failed delivery when the receiver returns a non-2xx status", async () => {
    registry.register({ name: "a", url: "https://a.com", events: ["order.created"] });
    const sender: WebhookSender = vi.fn().mockResolvedValue({ status: 500 });
    const dispatcher = new WebhookDispatcher(registry, tracker, sender);

    const summary = await dispatcher.dispatch("order.created", {});
    expect(summary.failed).toBe(1);
    const [delivery] = tracker.getAllDeliveries();
    expect(delivery.status).toBe("failed");
  });

  it("records a failed delivery when the sender throws (network error)", async () => {
    registry.register({ name: "a", url: "https://a.com", events: ["order.created"] });
    const sender: WebhookSender = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const dispatcher = new WebhookDispatcher(registry, tracker, sender);

    await dispatcher.dispatch("order.created", {});
    const [delivery] = tracker.getAllDeliveries();
    expect(delivery.status).toBe("failed");
    expect(delivery.error).toBe("ECONNREFUSED");
  });

  it("does not call the sender for events with no matching subscribers", async () => {
    registry.register({ name: "a", url: "https://a.com", events: ["order.shipped"] });
    const sender: WebhookSender = vi.fn().mockResolvedValue({ status: 200 });
    const dispatcher = new WebhookDispatcher(registry, tracker, sender);

    const summary = await dispatcher.dispatch("order.created", {});
    expect(summary.matchedWebhooks).toBe(0);
    expect(sender).not.toHaveBeenCalled();
  });

  describe("retry", () => {
    it("re-sends a failed delivery and marks it delivered on success", async () => {
      registry.register({ name: "a", url: "https://a.com", events: ["order.created"] });
      let callCount = 0;
      const sender: WebhookSender = vi.fn(async () => {
        callCount += 1;
        return callCount === 1 ? { status: 500 } : { status: 200 };
      });
      const dispatcher = new WebhookDispatcher(registry, tracker, sender);

      await dispatcher.dispatch("order.created", {});
      const [delivery] = tracker.getAllDeliveries();
      expect(delivery.status).toBe("failed");

      const ok = await dispatcher.retry(delivery.id);
      expect(ok).toBe(true);
      expect(tracker.getDelivery(delivery.id)?.status).toBe("delivered");
      expect(tracker.getDelivery(delivery.id)?.attempt).toBe(2);
    });

    it("throws when retrying a delivery for a webhook that no longer exists", async () => {
      registry.register({ name: "a", url: "https://a.com", events: ["order.created"] });
      const sender: WebhookSender = vi.fn().mockResolvedValue({ status: 500 });
      const dispatcher = new WebhookDispatcher(registry, tracker, sender);

      await dispatcher.dispatch("order.created", {});
      const [delivery] = tracker.getAllDeliveries();
      registry.clear();

      await expect(dispatcher.retry(delivery.id)).rejects.toThrow(/Webhook not found/);
    });
  });
});
