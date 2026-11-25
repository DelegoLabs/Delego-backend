-- Rollback for 20261020_courier_tracking_events.sql
DROP INDEX IF EXISTS idx_courier_tracking_carrier_number;
DROP INDEX IF EXISTS idx_courier_tracking_events_idempotency_key;
DROP TABLE IF EXISTS courier_tracking_events;
