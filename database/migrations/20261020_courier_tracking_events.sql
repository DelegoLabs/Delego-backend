-- Migration: 20261020_courier_tracking_events
-- Issue #571 — Courier webhook idempotency
-- Description: Courier webhooks (FedEx, DHL, UPS) often deliver duplicate delivery
--              status updates. A dedicated event log table with carrier event
--              idempotency keys prevents double-processing state transitions.
--
-- The unique index on idempotency_key allows `INSERT ... ON CONFLICT
-- (idempotency_key) DO NOTHING` to silently swallow duplicates in a single
-- round-trip, so re-delivered webhooks are acknowledged with HTTP 200 without
-- triggering downstream state transitions a second time.

BEGIN;

CREATE TABLE IF NOT EXISTS courier_tracking_events (
    id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    carrier           VARCHAR(32)   NOT NULL,
    tracking_number   VARCHAR(128)  NOT NULL,
    idempotency_key   VARCHAR(128)  NOT NULL,
    raw_status        VARCHAR(64)   NOT NULL,
    normalized_status VARCHAR(32)   NOT NULL,
    event_timestamp   TIMESTAMPTZ   NOT NULL,
    processed_at      TIMESTAMPTZ,
    error_message     TEXT,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Carrier-scoped unique constraint on the idempotency key so the
-- ON CONFLICT clause has a conflict target.
CREATE UNIQUE INDEX IF NOT EXISTS idx_courier_tracking_events_idempotency_key
    ON courier_tracking_events (idempotency_key);

-- Chronological look-up per carrier / tracking number.
CREATE INDEX IF NOT EXISTS idx_courier_tracking_carrier_number
    ON courier_tracking_events (carrier, tracking_number);

COMMIT;
