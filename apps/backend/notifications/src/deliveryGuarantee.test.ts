/**
 * Unit tests for #149 — delivery guarantee service.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  InMemoryDeliveryReceiptStore,
  InMemoryDeliveryOrderTracker,
  DeliveryGuaranteeService,
  generateIdempotencyKey,
} from "./deliveryGuarantee.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("delivery guarantee", () => {
  let receiptStore: InMemoryDeliveryReceiptStore;
  let orderTracker: InMemoryDeliveryOrderTracker;
  let service: DeliveryGuaranteeService;

  beforeEach(() => {
    receiptStore = new InMemoryDeliveryReceiptStore();
    orderTracker = new InMemoryDeliveryOrderTracker();
    service = new DeliveryGuaranteeService({
      receiptStore,
      orderTracker,
      confirmationTimeoutMs: 5000,
    });
  });

  describe("generateIdempotencyKey", () => {
    it("produces deterministic keys for same input", () => {
      const key1 = generateIdempotencyKey({
        userId: "u1",
        channel: "email",
        eventType: "order_confirmation",
        entityId: "ord-123",
      });
      const key2 = generateIdempotencyKey({
        userId: "u1",
        channel: "email",
        eventType: "order_confirmation",
        entityId: "ord-123",
      });
      expect(key1).toBe(key2);
    });

    it("produces different keys for different inputs", () => {
      const key1 = generateIdempotencyKey({
        userId: "u1",
        channel: "email",
        eventType: "order_confirmation",
        entityId: "ord-123",
      });
      const key2 = generateIdempotencyKey({
        userId: "u2",
        channel: "email",
        eventType: "order_confirmation",
        entityId: "ord-123",
      });
      expect(key1).not.toBe(key2);
    });

    it("includes channel in key", () => {
      const key = generateIdempotencyKey({
        userId: "u1",
        channel: "push",
        eventType: "order_confirmation",
        entityId: "ord-123",
      });
      expect(key).toContain("push");
    });
  });

  describe("DeliveryGuaranteeService", () => {
    it("tracks a new delivery and returns non-duplicate", async () => {
      const { receipt, isDuplicate } = await service.trackDelivery({
        notificationId: "n1",
        channel: "email",
        externalId: "ext-1",
        idempotencyKey: "idem-1",
      });

      expect(isDuplicate).toBe(false);
      expect(receipt.status).toBe("pending");
      expect(receipt.notificationId).toBe("n1");
      expect(receipt.channel).toBe("email");

      const metrics = service.getMetrics("email");
      expect(metrics.totalSent).toBe(1);
      expect(metrics.pending).toBe(1);
    });

    it("detects duplicate deliveries", async () => {
      await service.trackDelivery({
        notificationId: "n1",
        channel: "email",
        externalId: "ext-dup",
        idempotencyKey: "idem-dup",
      });

      const { isDuplicate } = await service.trackDelivery({
        notificationId: "n2",
        channel: "email",
        externalId: "ext-dup",
        idempotencyKey: "idem-dup-2",
      });

      expect(isDuplicate).toBe(true);

      const metrics = service.getMetrics("email");
      expect(metrics.duplicatesDetected).toBe(1);
      expect(metrics.totalSent).toBe(1); // Only first counted
    });

    it("confirms delivery and updates metrics", async () => {
      await service.trackDelivery({
        notificationId: "n1",
        channel: "push",
        externalId: "ext-1",
        idempotencyKey: "idem-1",
      });

      const confirmed = await service.confirmDelivery("n1", "push");
      expect(confirmed).toBe(true);

      const metrics = service.getMetrics("push");
      expect(metrics.confirmed).toBe(1);
      expect(metrics.pending).toBe(0);
    });

    it("records failure and updates metrics", async () => {
      await service.trackDelivery({
        notificationId: "n1",
        channel: "sms",
        externalId: "ext-1",
        idempotencyKey: "idem-1",
      });

      await service.recordFailure("n1", "sms", "network timeout");

      const metrics = service.getMetrics("sms");
      expect(metrics.failed).toBe(1);
      expect(metrics.pending).toBe(0);
    });

    it("tracks ordering per user/channel", async () => {
      const can1 = await service.canDeliverInOrder("u1", "push", 1);
      expect(can1).toBe(true);

      await service.markOrderedDelivery("u1", "push", 1);

      const can2 = await service.canDeliverInOrder("u1", "push", 2);
      expect(can2).toBe(true);

      const canDup = await service.canDeliverInOrder("u1", "push", 1);
      expect(canDup).toBe(false); // Already delivered
    });

    it("returns all channel metrics", async () => {
      await service.trackDelivery({
        notificationId: "n1",
        channel: "email",
        externalId: "e1",
        idempotencyKey: "i1",
      });
      await service.trackDelivery({
        notificationId: "n2",
        channel: "push",
        externalId: "p1",
        idempotencyKey: "i2",
      });

      const allMetrics = service.getAllMetrics();
      expect(allMetrics.length).toBe(5); // email, push, in_app, sms, webhook
      expect(allMetrics.find((m) => m.channel === "email")?.totalSent).toBe(1);
      expect(allMetrics.find((m) => m.channel === "push")?.totalSent).toBe(1);
    });

    it("returns zero metrics for channels with no activity", async () => {
      const metrics = service.getMetrics("webhook");
      expect(metrics.totalSent).toBe(0);
      expect(metrics.confirmed).toBe(0);
      expect(metrics.pending).toBe(0);
      expect(metrics.failed).toBe(0);
      expect(metrics.avgConfirmationMs).toBe(0);
    });
  });

  describe("DeliveryOrderTracker", () => {
    it("allows sequential delivery", async () => {
      expect(await orderTracker.canDeliver({ userId: "u1", channel: "push" }, 1)).toBe(true);
      await orderTracker.markDelivered({ userId: "u1", channel: "push" }, 1);
      expect(await orderTracker.canDeliver({ userId: "u1", channel: "push" }, 2)).toBe(true);
    });

    it("rejects out-of-order delivery", async () => {
      await orderTracker.markDelivered({ userId: "u1", channel: "push" }, 5);
      expect(await orderTracker.canDeliver({ userId: "u1", channel: "push" }, 3)).toBe(false);
    });

    it("tracks per-user and per-channel independently", async () => {
      await orderTracker.markDelivered({ userId: "u1", channel: "push" }, 3);
      expect(await orderTracker.canDeliver({ userId: "u2", channel: "push" }, 1)).toBe(true);
      expect(await orderTracker.canDeliver({ userId: "u1", channel: "email" }, 1)).toBe(true);
    });

    it("returns last delivered sequence", async () => {
      expect(await orderTracker.getLastDeliveredSequence({ userId: "u1", channel: "push" })).toBe(0);
      await orderTracker.markDelivered({ userId: "u1", channel: "push" }, 5);
      expect(await orderTracker.getLastDeliveredSequence({ userId: "u1", channel: "push" })).toBe(5);
    });
  });
});
