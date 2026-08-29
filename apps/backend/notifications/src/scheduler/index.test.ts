import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelScheduledNotification,
  catchUpMissedNotifications,
  getScheduledNotification,
  getSchedulerMetrics,
  listScheduledNotifications,
  processDueNotifications,
  resetScheduledNotificationStore,
  scheduleNotification,
  scheduleRecurringNotification,
} from "./index.js";

describe("notification scheduler", () => {
  beforeEach(() => {
    resetScheduledNotificationStore();
  });

  describe("scheduleNotification", () => {
    it("schedules a one-time notification for a future timestamp", async () => {
      const runAt = new Date(Date.now() + 60_000).toISOString();
      const record = await scheduleNotification({
        userId: "user-1",
        templateName: "payment-reminder",
        payload: { orderId: "order-1" },
        runAt,
      });

      expect(record.status).toBe("pending");
      expect(record.runAt).toBe(runAt);
      expect(record.cronExpression).toBeUndefined();

      const fetched = await getScheduledNotification(record.id);
      expect(fetched).toEqual(record);
    });

    it("rejects a runAt timestamp in the past", async () => {
      await expect(
        scheduleNotification({
          userId: "user-1",
          templateName: "payment-reminder",
          payload: {},
          runAt: new Date(Date.now() - 60_000).toISOString(),
        })
      ).rejects.toThrow("future timestamp");
    });
  });

  describe("scheduleRecurringNotification", () => {
    it("schedules a recurring notification and computes the first cron run", async () => {
      const from = new Date(Date.UTC(2026, 0, 1, 10, 0));
      const record = await scheduleRecurringNotification({
        userId: "user-1",
        templateName: "delegation-expiry-warning",
        payload: {},
        cronExpression: "0 9 * * *",
        from,
      });

      expect(record.cronExpression).toBe("0 9 * * *");
      expect(record.runAt).toBe(new Date(Date.UTC(2026, 0, 2, 9, 0)).toISOString());
    });

    it("rejects an invalid cron expression", async () => {
      await expect(
        scheduleRecurringNotification({
          userId: "user-1",
          templateName: "x",
          payload: {},
          cronExpression: "not-a-cron",
        })
      ).rejects.toThrow("Invalid cron expression");
    });
  });

  describe("cancelScheduledNotification", () => {
    it("cancels a pending notification", async () => {
      const record = await scheduleNotification({
        userId: "user-1",
        templateName: "payment-reminder",
        payload: {},
        runAt: new Date(Date.now() + 60_000).toISOString(),
      });

      const cancelled = await cancelScheduledNotification(record.id);
      expect(cancelled?.status).toBe("cancelled");

      const fetched = await getScheduledNotification(record.id);
      expect(fetched?.status).toBe("cancelled");
    });

    it("returns null for an unknown id", async () => {
      const result = await cancelScheduledNotification("does-not-exist");
      expect(result).toBeNull();
    });
  });

  describe("processDueNotifications", () => {
    it("dispatches due one-time notifications and marks them dispatched", async () => {
      const record = await scheduleNotification({
        userId: "user-1",
        templateName: "payment-reminder",
        payload: { orderId: "order-1" },
        runAt: new Date(Date.now() + 1000).toISOString(),
      });

      const dispatch = vi.fn();
      const asOf = new Date(Date.now() + 2000);
      const result = await processDueNotifications(dispatch, asOf);

      expect(result.dispatched).toBe(1);
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: record.id }));

      const fetched = await getScheduledNotification(record.id);
      expect(fetched?.status).toBe("dispatched");
    });

    it("does not dispatch cancelled notifications", async () => {
      const record = await scheduleNotification({
        userId: "user-1",
        templateName: "payment-reminder",
        payload: {},
        runAt: new Date(Date.now() + 1000).toISOString(),
      });
      await cancelScheduledNotification(record.id);

      const dispatch = vi.fn();
      const result = await processDueNotifications(dispatch, new Date(Date.now() + 2000));

      expect(result.dispatched).toBe(0);
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("reschedules recurring notifications to their next cron occurrence", async () => {
      const from = new Date(Date.UTC(2026, 0, 1, 8, 59));
      const record = await scheduleRecurringNotification({
        userId: "user-1",
        templateName: "delegation-expiry-warning",
        payload: {},
        cronExpression: "0 9 * * *",
        from,
      });
      expect(record.runAt).toBe(new Date(Date.UTC(2026, 0, 1, 9, 0)).toISOString());

      const dispatch = vi.fn();
      const asOf = new Date(Date.UTC(2026, 0, 1, 9, 0));
      const result = await processDueNotifications(dispatch, asOf);

      expect(result.dispatched).toBe(1);
      expect(result.rescheduled).toBe(1);

      const fetched = await getScheduledNotification(record.id);
      expect(fetched?.status).toBe("pending");
      expect(fetched?.runAt).toBe(new Date(Date.UTC(2026, 0, 2, 9, 0)).toISOString());
    });

    it("leaves a notification pending and reports a failure when dispatch throws", async () => {
      const record = await scheduleNotification({
        userId: "user-1",
        templateName: "payment-reminder",
        payload: {},
        runAt: new Date(Date.now() + 1000).toISOString(),
      });

      const dispatch = vi.fn().mockRejectedValue(new Error("smtp down"));
      const result = await processDueNotifications(dispatch, new Date(Date.now() + 2000));

      expect(result.dispatched).toBe(0);
      expect(result.failed).toBe(1);

      const fetched = await getScheduledNotification(record.id);
      expect(fetched?.status).toBe("pending");
    });

    it("does not dispatch the same notification twice when two pollers race (distributed locking)", async () => {
      await scheduleNotification({
        userId: "user-1",
        templateName: "payment-reminder",
        payload: {},
        runAt: new Date(Date.now() + 1000).toISOString(),
      });

      const dispatch = vi.fn().mockResolvedValue(undefined);
      const asOf = new Date(Date.now() + 2000);

      // Two "scheduler instances" polling concurrently for the same due notification.
      const [resultA, resultB] = await Promise.all([
        processDueNotifications(dispatch, asOf, { claimedBy: "poller-a" }),
        processDueNotifications(dispatch, asOf, { claimedBy: "poller-b" }),
      ]);

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(resultA.dispatched + resultB.dispatched).toBe(1);
    });
  });

  describe("timezone-aware recurring notifications (Issue #59)", () => {
    it("schedules the first occurrence using the given IANA timezone", async () => {
      // 2026-01-01 05:00 EST (10:00 UTC) — before 9am EST, so next occurrence is
      // later the same day.
      const from = new Date(Date.UTC(2026, 0, 1, 10, 0));
      const record = await scheduleRecurringNotification({
        userId: "user-1",
        templateName: "delegation-expiry-warning",
        payload: {},
        cronExpression: "0 9 * * *",
        timezone: "America/New_York",
        from,
      });

      expect(record.timezone).toBe("America/New_York");
      expect(record.runAt).toBe(new Date(Date.UTC(2026, 0, 1, 14, 0)).toISOString());
    });

    it("defaults to UTC when no timezone is given", async () => {
      const record = await scheduleRecurringNotification({
        userId: "user-1",
        templateName: "delegation-expiry-warning",
        payload: {},
        cronExpression: "0 9 * * *",
        from: new Date(Date.UTC(2026, 0, 1, 10, 0)),
      });
      expect(record.timezone).toBe("UTC");
    });

    it("reschedules subsequent occurrences honoring the DST-shifted UTC offset", async () => {
      // Schedule just before the US spring-forward DST transition (2026-03-08).
      const from = new Date(Date.UTC(2026, 2, 7, 0, 0));
      const record = await scheduleRecurringNotification({
        userId: "user-1",
        templateName: "delegation-expiry-warning",
        payload: {},
        cronExpression: "0 9 * * *",
        timezone: "America/New_York",
        from,
      });
      // Before DST: EST, UTC-05:00.
      expect(record.runAt).toBe(new Date(Date.UTC(2026, 2, 7, 14, 0)).toISOString());

      const dispatch = vi.fn();
      await processDueNotifications(dispatch, new Date(Date.UTC(2026, 2, 7, 14, 0)));

      const fetched = await getScheduledNotification(record.id);
      // After DST: EDT, UTC-04:00 — same 9am local time, one hour earlier in UTC.
      expect(fetched?.runAt).toBe(new Date(Date.UTC(2026, 2, 8, 13, 0)).toISOString());
    });

    it("stops rescheduling once endAt is reached", async () => {
      const from = new Date(Date.UTC(2026, 0, 1, 8, 0));
      const record = await scheduleRecurringNotification({
        userId: "user-1",
        templateName: "delegation-expiry-warning",
        payload: {},
        cronExpression: "0 9 * * *",
        from,
        endAt: new Date(Date.UTC(2026, 0, 2, 0, 0)).toISOString(), // before the 2nd occurrence
      });

      const dispatch = vi.fn();
      await processDueNotifications(dispatch, new Date(Date.UTC(2026, 0, 1, 9, 0)));

      const fetched = await getScheduledNotification(record.id);
      expect(fetched?.status).toBe("dispatched");
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it("rejects scheduling when the first occurrence is already at or after endAt", async () => {
      const from = new Date(Date.UTC(2026, 0, 1, 8, 0));
      await expect(
        scheduleRecurringNotification({
          userId: "user-1",
          templateName: "x",
          payload: {},
          cronExpression: "0 9 * * *",
          from,
          endAt: new Date(Date.UTC(2026, 0, 1, 9, 0)).toISOString(),
        })
      ).rejects.toThrow(/endAt/);
    });

    it("stops rescheduling once maxRuns is reached", async () => {
      const from = new Date(Date.UTC(2026, 0, 1, 8, 0));
      const record = await scheduleRecurringNotification({
        userId: "user-1",
        templateName: "delegation-expiry-warning",
        payload: {},
        cronExpression: "0 9 * * *",
        from,
        maxRuns: 1,
      });

      const dispatch = vi.fn();
      await processDueNotifications(dispatch, new Date(Date.UTC(2026, 0, 1, 9, 0)));

      const fetched = await getScheduledNotification(record.id);
      expect(fetched?.status).toBe("dispatched");
      expect(fetched?.runCount).toBe(1);
    });

    it("rejects a non-positive maxRuns", async () => {
      await expect(
        scheduleRecurringNotification({
          userId: "user-1",
          templateName: "x",
          payload: {},
          cronExpression: "0 9 * * *",
          maxRuns: 0,
        })
      ).rejects.toThrow(/maxRuns/);
    });
  });

  describe("listScheduledNotifications (Issue #59 CRUD API)", () => {
    it("lists a user's notifications, most recently created first", async () => {
      const first = await scheduleNotification({
        userId: "user-list",
        templateName: "a",
        payload: {},
        runAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const second = await scheduleNotification({
        userId: "user-list",
        templateName: "b",
        payload: {},
        runAt: new Date(Date.now() + 120_000).toISOString(),
      });

      const results = await listScheduledNotifications("user-list");
      expect(results.map((r) => r.id)).toEqual([second.id, first.id]);
    });

    it("does not return another user's notifications", async () => {
      await scheduleNotification({
        userId: "user-a",
        templateName: "a",
        payload: {},
        runAt: new Date(Date.now() + 60_000).toISOString(),
      });

      const results = await listScheduledNotifications("user-b");
      expect(results).toEqual([]);
    });

    it("filters by status", async () => {
      const cancelled = await scheduleNotification({
        userId: "user-filter",
        templateName: "a",
        payload: {},
        runAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await cancelScheduledNotification(cancelled.id);
      await scheduleNotification({
        userId: "user-filter",
        templateName: "b",
        payload: {},
        runAt: new Date(Date.now() + 60_000).toISOString(),
      });

      const cancelledOnly = await listScheduledNotifications("user-filter", { status: "cancelled" });
      expect(cancelledOnly).toHaveLength(1);
      expect(cancelledOnly[0].id).toBe(cancelled.id);
    });

    it("respects the limit option", async () => {
      for (let i = 0; i < 5; i++) {
        await scheduleNotification({
          userId: "user-limit",
          templateName: `t-${i}`,
          payload: {},
          runAt: new Date(Date.now() + 60_000 + i).toISOString(),
        });
      }

      const results = await listScheduledNotifications("user-limit", { limit: 2 });
      expect(results).toHaveLength(2);
    });
  });

  describe("getSchedulerMetrics (Issue #59 health monitoring)", () => {
    it("reports counts by status and upcoming run times", async () => {
      const scheduled = await scheduleNotification({
        userId: "user-metrics",
        templateName: "a",
        payload: {},
        runAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const toCancel = await scheduleNotification({
        userId: "user-metrics",
        templateName: "b",
        payload: {},
        runAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await cancelScheduledNotification(toCancel.id);

      const toDispatch = await scheduleNotification({
        userId: "user-metrics",
        templateName: "c",
        payload: {},
        runAt: new Date(Date.now() + 1000).toISOString(),
      });
      await processDueNotifications(vi.fn(), new Date(Date.now() + 2000));

      const metrics = await getSchedulerMetrics();
      expect(metrics.scheduled).toBe(1);
      expect(metrics.cancelled).toBe(1);
      expect(metrics.dispatched).toBe(1);
      expect(metrics.nextRunTimes.some((n) => n.id === scheduled.id)).toBe(true);
      expect(metrics.nextRunTimes.some((n) => n.id === toDispatch.id)).toBe(false);
    });
  });

  describe("catchUpMissedNotifications (Issue #59)", () => {
    it("dispatches a notification whose runAt fell within the catch-up window while the scheduler was down", async () => {
      const now = new Date();
      // Simulate a notification that was due 2 minutes ago (scheduler was down).
      const record = await scheduleNotification({
        userId: "user-catchup",
        templateName: "payment-reminder",
        payload: {},
        runAt: new Date(now.getTime() + 1000).toISOString(),
      });
      // Advance "now" 2 minutes past runAt without ever having polled in between.
      const resumedAt = new Date(now.getTime() + 2 * 60_000);

      const dispatch = vi.fn();
      const result = await catchUpMissedNotifications(
        dispatch,
        { catchUpWindowMs: 5 * 60_000, batchSize: 50 },
        resumedAt
      );

      expect(result.dispatched).toBe(1);
      expect(result.skipped).toBe(0);
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: record.id }));
    });

    it("leaves notifications older than the catch-up window pending and reports them as skipped", async () => {
      const now = new Date();
      await scheduleNotification({
        userId: "user-catchup-old",
        templateName: "payment-reminder",
        payload: {},
        runAt: new Date(now.getTime() + 1000).toISOString(),
      });
      // Resume 10 minutes later — beyond a 5-minute catch-up window.
      const resumedAt = new Date(now.getTime() + 10 * 60_000);

      const dispatch = vi.fn();
      const result = await catchUpMissedNotifications(
        dispatch,
        { catchUpWindowMs: 5 * 60_000, batchSize: 50 },
        resumedAt
      );

      expect(result.dispatched).toBe(0);
      expect(result.skipped).toBe(1);
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("is a no-op when nothing is due", async () => {
      const dispatch = vi.fn();
      const result = await catchUpMissedNotifications(dispatch);
      expect(result).toEqual({ dispatched: 0, failed: 0, rescheduled: 0, skipped: 0 });
      expect(dispatch).not.toHaveBeenCalled();
    });
  });
});
