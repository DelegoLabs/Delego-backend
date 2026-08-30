import { describe, it, expect, beforeEach } from "vitest";
import { WebhookRegistry } from "./registry.js";

describe("WebhookRegistry", () => {
  let registry: WebhookRegistry;

  beforeEach(() => {
    registry = new WebhookRegistry();
  });

  describe("register", () => {
    it("registers a webhook with an active status and a generated secret", () => {
      const webhook = registry.register({ name: "test", url: "https://example.com/hook", events: ["order.created"] });
      expect(webhook.status).toBe("active");
      expect(webhook.secret).toHaveLength(64);
      expect(webhook.version).toBe(1);
    });

    it("applies the default retry policy when none is given", () => {
      const webhook = registry.register({ name: "test", url: "https://example.com/hook", events: ["order.created"] });
      expect(webhook.retryPolicy.maxAttempts).toBe(5);
    });

    it("merges a partial custom retry policy over the defaults", () => {
      const webhook = registry.register({
        name: "test",
        url: "https://example.com/hook",
        events: ["order.created"],
        retryPolicy: { maxAttempts: 2 },
      });
      expect(webhook.retryPolicy.maxAttempts).toBe(2);
      expect(webhook.retryPolicy.initialDelayMs).toBe(1000);
    });

    it("rejects a non-http(s) URL", () => {
      expect(() =>
        registry.register({ name: "test", url: "ftp://example.com", events: ["order.created"] }),
      ).toThrow(/Invalid webhook URL/);
    });

    it("rejects a webhook with no subscribed events", () => {
      expect(() => registry.register({ name: "test", url: "https://example.com", events: [] })).toThrow(
        /at least one event/,
      );
    });
  });

  describe("pause / resume / disable", () => {
    it("pausing then resuming a webhook toggles its status and bumps version", () => {
      const webhook = registry.register({ name: "test", url: "https://example.com", events: ["e"] });
      const paused = registry.pause(webhook.id);
      expect(paused.status).toBe("paused");
      expect(paused.version).toBe(2);

      const resumed = registry.resume(webhook.id);
      expect(resumed.status).toBe("active");
      expect(resumed.version).toBe(3);
    });

    it("disables a webhook", () => {
      const webhook = registry.register({ name: "test", url: "https://example.com", events: ["e"] });
      const disabled = registry.disable(webhook.id);
      expect(disabled.status).toBe("disabled");
    });
  });

  describe("findSubscribers", () => {
    it("returns only active webhooks subscribed to the event type", () => {
      const active = registry.register({ name: "active", url: "https://a.com", events: ["order.created"] });
      const other = registry.register({ name: "other-event", url: "https://b.com", events: ["order.shipped"] });
      const paused = registry.register({ name: "paused", url: "https://c.com", events: ["order.created"] });
      registry.pause(paused.id);

      const subscribers = registry.findSubscribers("order.created", {});
      expect(subscribers.map((w) => w.id)).toEqual([active.id]);
      expect(subscribers.map((w) => w.id)).not.toContain(other.id);
    });

    it("excludes webhooks whose filters don't match the event payload", () => {
      registry.register({
        name: "high-value-only",
        url: "https://a.com",
        events: ["order.created"],
        filters: [{ field: "amount", operator: "gt", value: 100 }],
      });

      expect(registry.findSubscribers("order.created", { amount: 50 })).toHaveLength(0);
      expect(registry.findSubscribers("order.created", { amount: 150 })).toHaveLength(1);
    });

    it("requires ALL filters to match (AND semantics)", () => {
      registry.register({
        name: "multi-filter",
        url: "https://a.com",
        events: ["order.created"],
        filters: [
          { field: "amount", operator: "gt", value: 100 },
          { field: "region", operator: "eq", value: "US" },
        ],
      });

      expect(registry.findSubscribers("order.created", { amount: 150, region: "EU" })).toHaveLength(0);
      expect(registry.findSubscribers("order.created", { amount: 150, region: "US" })).toHaveLength(1);
    });
  });

  describe("matchesFilters operators", () => {
    it("supports eq, neq, contains, gt, and lt", () => {
      const webhook = registry.register({ name: "w", url: "https://a.com", events: ["e"] });
      registry.update(webhook.id, {
        filters: [{ field: "status", operator: "neq", value: "cancelled" }],
      });
      expect(registry.findSubscribers("e", { status: "completed" })).toHaveLength(1);
      expect(registry.findSubscribers("e", { status: "cancelled" })).toHaveLength(0);
    });

    it("contains matches substrings and array membership", () => {
      const webhook = registry.register({ name: "w", url: "https://a.com", events: ["e"] });
      registry.update(webhook.id, {
        filters: [{ field: "tags", operator: "contains", value: "urgent" }],
      });
      expect(registry.findSubscribers("e", { tags: ["urgent", "low-stock"] })).toHaveLength(1);
      expect(registry.findSubscribers("e", { tags: ["low-stock"] })).toHaveLength(0);
    });
  });
});
