// Issue #571 — Courier tracking event idempotency
//
// Courier webhooks (FedEx, DHL, UPS) often deliver duplicate delivery status
// updates. This module persists each inbound event in the
// `courier_tracking_events` table with a unique `idempotency_key` so that
// duplicate deliveries are silently swallowed via
// `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING id` — a single
// round-trip that resolves races between concurrent webhook deliveries to
// exactly one winner.

import { Pool } from "pg";

export type CourierCarrier = "fedex" | "dhl" | "ups";

export interface CourierTrackingEvent {
  carrier: CourierCarrier;
  trackingNumber: string;
  idempotencyKey: string;
  rawStatus: string;
  normalizedStatus: string;
  eventTimestamp: Date;
}

export interface CourierTrackingEventRecord extends CourierTrackingEvent {
  id: string;
  processedAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
}

export interface CourierTrackingEventStore {
  /**
   * Idempotently insert a courier tracking event.
   *
   * Returns `true` when this is the first delivery (the row was inserted),
   * `false` when the idempotency key was already seen (duplicate — skip).
   *
   * Postgres implementations should use
   * `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`.
   */
  record(event: CourierTrackingEvent): Promise<boolean>;
}

/** In-memory store for tests and local development. */
export class InMemoryCourierTrackingEventStore
  implements CourierTrackingEventStore
{
  private readonly seen = new Map<string, CourierTrackingEventRecord>();

  async record(event: CourierTrackingEvent): Promise<boolean> {
    if (this.seen.has(event.idempotencyKey)) {
      return false;
    }

    this.seen.set(event.idempotencyKey, {
      ...event,
      id: crypto.randomUUID(),
      processedAt: null,
      errorMessage: null,
      createdAt: new Date(),
    });
    return true;
  }

  /** Test helper — returns whether an idempotency key was recorded. */
  has(idempotencyKey: string): boolean {
    return this.seen.has(idempotencyKey);
  }

  clear(): void {
    this.seen.clear();
  }
}

/**
 * Postgres-backed CourierTrackingEventStore.
 *
 * Uses `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING id` so the
 * atomic claim happens in a single round-trip and races between concurrent
 * webhook deliveries resolve to exactly one winner.
 */
export class PostgresCourierTrackingEventStore
  implements CourierTrackingEventStore
{
  constructor(private readonly pool: Pool) {}

  async record(event: CourierTrackingEvent): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO courier_tracking_events
         (carrier, tracking_number, idempotency_key, raw_status,
          normalized_status, event_timestamp)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        event.carrier,
        event.trackingNumber,
        event.idempotencyKey,
        event.rawStatus,
        event.normalizedStatus,
        event.eventTimestamp,
      ]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

let courierTrackingEventStore: CourierTrackingEventStore =
  new InMemoryCourierTrackingEventStore();

/** Swap the backing store for a Postgres implementation in production. */
export function setCourierTrackingEventStore(
  store: CourierTrackingEventStore
): void {
  courierTrackingEventStore = store;
}

export function resetCourierTrackingEventStore(): void {
  courierTrackingEventStore = new InMemoryCourierTrackingEventStore();
}

/**
 * Idempotently record a courier tracking event.
 * Returns `true` on first delivery (proceed with state transition),
 * `false` when already recorded (acknowledge webhook but skip processing).
 *
 * Backed by `courier_tracking_events`
 * (see database/migrations/20261020_courier_tracking_events.sql).
 */
export async function recordCourierTrackingEvent(
  event: CourierTrackingEvent
): Promise<boolean> {
  if (!event.idempotencyKey || event.idempotencyKey.trim() === "") {
    throw new Error("idempotencyKey is required");
  }

  if (!event.trackingNumber || event.trackingNumber.trim() === "") {
    throw new Error("trackingNumber is required");
  }

  if (!event.carrier || event.carrier.trim() === "") {
    throw new Error("carrier is required");
  }

  return courierTrackingEventStore.record(event);
}
