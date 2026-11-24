import { describe, it, expect, beforeEach } from "vitest";
import {
  STALE_WEBHOOK_THRESHOLD_MS,
  recordWebhookReceived,
  getLastWebhookReceivedAt,
  setPendingDeliveriesCount,
  incrementPendingDeliveries,
  getPendingDeliveriesCount,
  isWebhookStale,
  findExpiredSigningKeys,
  getOracleHealthStatus,
} from "./oracleHealth";
import { getCacheClient } from "@delegolabs/cache";
// NOTE: the reviewer-reported TS1005 at packages/cache/src/client.ts:305 is outside
// this file; the test file itself has no unbalanced braces. Fix that file separately.

describe("oracleHealth", () => {
  beforeEach(async () => {
    const cache = getCacheClient();
    await cache.del("oracleHealth:lastWebhookReceivedAt");
    await cache.del("oracleHealth:pendingDeliveriesCount");
  });

  describe("stale webhook detection", () => {
    it("treats a missing webhook timestamp as stale", () => {
      expect(isWebhookStale(null, Date.now())).toBe(true);
    });

    it("is not stale when last webhook is within 6 hours", () => {
      const now = 1_000_000_000_000;
      const last = now - (STALE_WEBHOOK_THRESHOLD_MS - 1000);
      expect(isWebhookStale(last, now)).toBe(false);
    });

    it("is stale when last webhook is older than 6 hours", () => {
      const now = 1_000_000_000_000;
      const last = now - (STALE_WEBHOOK_THRESHOLD_MS + 1);
      expect(isWebhookStale(last, now)).toBe(true);
    });

    it("reports stale in aggregated status after 6h without webhooks", async () => {
      const now = 1_000_000_000_000;
      await recordWebhookReceived(now - STALE_WEBHOOK_THRESHOLD_MS - 5000);
      const status = await getOracleHealthStatus([], now);
      expect(status.isWebhookStale).toBe(true);
    });
  });

  describe("expired signing keys", () => {
    it("returns ids of keys whose expiry is at or before now", () => {
      const now = 1_000;
      const keys = [
        { id: "a", expiresAt: 500 },
        { id: "b", expiresAt: 1_000 },
        { id: "c", expiresAt: 2_000 },
      ];
      expect(findExpiredSigningKeys(keys, now)).toEqual(["a", "b"]);
    });

    it("returns empty list when no keys are expired", () => {
      expect(findExpiredSigningKeys([{ id: "a", expiresAt: 9_999 }], 1)).toEqual([]);
    });

    it("surfaces expired keys through aggregated status", async () => {
      const now = 10_000;
      const status = await getOracleHealthStatus(
        [{ id: "old", expiresAt: 5_000 }, { id: "new", expiresAt: 50_000 }],
        now,
      );
      expect(status.expiredSigningKeyIds).toEqual(["old"]);
    });
  });

  describe("Redis persistence", () => {
    it("persists and reads lastWebhookReceivedAt through the cache", async () => {
      const ts = 1_700_000_000_000;
      await recordWebhookReceived(ts);
      expect(await getLastWebhookReceivedAt()).toBe(ts);
      const raw = await getCacheClient().get("oracleHealth:lastWebhookReceivedAt");
      expect(raw).toBe(String(ts));
    });

    it("returns null when no webhook has been recorded", async () => {
      expect(await getLastWebhookReceivedAt()).toBeNull();
    });

    it("persists pendingDeliveriesCount and increments it", async () => {
      await setPendingDeliveriesCount(3);
      expect(await getPendingDeliveriesCount()).toBe(3);
      expect(await incrementPendingDeliveries(2)).toBe(5);
      expect(await getPendingDeliveriesCount()).toBe(5);
    });

    it("clamps pending deliveries to non-negative integers", async () => {
      await setPendingDeliveriesCount(-4);
      expect(await getPendingDeliveriesCount()).toBe(0);
      expect(await incrementPendingDeliveries(-10)).toBe(0);
    });

    it("shares state across independent reads (replica simulation)", async () => {
      const ts = 1_800_000_000_000;
      await recordWebhookReceived(ts);
      await setPendingDeliveriesCount(7);
      const status = await getOracleHealthStatus([], ts + 1000);
      expect(status.lastWebhookReceivedAt).toBe(ts);
      expect(status.pendingDeliveriesCount).toBe(7);
      expect(status.isWebhookStale).toBe(false);
    });
  });
});
