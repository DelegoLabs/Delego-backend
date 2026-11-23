import { describe, it, expect, beforeEach } from "vitest";
import {
  recordCourierTrackingEvent,
  resetCourierTrackingEventStore,
  PostgresCourierTrackingEventStore,
  type CourierTrackingEvent,
} from "./courier-tracking-events.js";

const baseEvent: CourierTrackingEvent = {
  carrier: "fedex",
  trackingNumber: "780123456",
  idempotencyKey: "fedex:780123456:evt-001",
  rawStatus: "DELIVERED",
  normalizedStatus: "delivered",
  eventTimestamp: new Date("2026-10-20T12:00:00Z"),
};

describe("recordCourierTrackingEvent", () => {
  beforeEach(() => {
    resetCourierTrackingEventStore();
  });

  it("returns true on first delivery", async () => {
    const result = await recordCourierTrackingEvent(baseEvent);
    expect(result).toBe(true);
  });

  it("returns false on duplicate idempotency key", async () => {
    await recordCourierTrackingEvent(baseEvent);
    const duplicate = await recordCourierTrackingEvent(baseEvent);
    expect(duplicate).toBe(false);
  });

  it("allows different idempotency keys for the same tracking number", async () => {
    const first = await recordCourierTrackingEvent(baseEvent);
    const second = await recordCourierTrackingEvent({
      ...baseEvent,
      idempotencyKey: "fedex:780123456:evt-002",
      rawStatus: "IN_TRANSIT",
    });
    expect(first).toBe(true);
    expect(second).toBe(true);
  });

  it("rejects empty idempotency key", async () => {
    await expect(
      recordCourierTrackingEvent({ ...baseEvent, idempotencyKey: "" })
    ).rejects.toThrow("idempotencyKey is required");
  });

  it("rejects empty tracking number", async () => {
    await expect(
      recordCourierTrackingEvent({ ...baseEvent, trackingNumber: "" })
    ).rejects.toThrow("trackingNumber is required");
  });

  it("rejects empty carrier", async () => {
    await expect(
      recordCourierTrackingEvent({ ...baseEvent, carrier: "" as never })
    ).rejects.toThrow("carrier is required");
  });
});

describe("PostgresCourierTrackingEventStore", () => {
  function mockPool(rowCount: number) {
    return {
      query: async () => ({
        rowCount,
        rows: rowCount > 0 ? [{ id: "uuid-1" }] : [],
      }),
    } as unknown as import("pg").Pool;
  }

  it("returns true when the INSERT ... ON CONFLICT claims the row", async () => {
    const store = new PostgresCourierTrackingEventStore(mockPool(1));
    await expect(store.record(baseEvent)).resolves.toBe(true);
  });

  it("returns false when ON CONFLICT DO NOTHING skips a duplicate", async () => {
    const store = new PostgresCourierTrackingEventStore(mockPool(0));
    await expect(store.record(baseEvent)).resolves.toBe(false);
  });

  it("issues a single parameterized query with ON CONFLICT (idempotency_key) DO NOTHING", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        capturedSql = sql;
        capturedParams = params;
        return { rowCount: 1, rows: [{ id: "uuid-7" }] };
      },
    } as unknown as import("pg").Pool;

    const store = new PostgresCourierTrackingEventStore(pool);
    await store.record(baseEvent);

    expect(capturedSql).toMatch(
      /ON CONFLICT \(idempotency_key\) DO NOTHING/
    );
    expect(capturedSql).toMatch(/RETURNING id/);
    expect(capturedParams).toEqual([
      "fedex",
      "780123456",
      "fedex:780123456:evt-001",
      "DELIVERED",
      "delivered",
      baseEvent.eventTimestamp,
    ]);
  });
});
