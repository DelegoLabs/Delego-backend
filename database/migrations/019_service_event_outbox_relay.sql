-- Migration: 019_service_event_outbox_relay
-- Description: Adds retry/claim bookkeeping to service_event_outbox so the
-- OutboxRelay worker can drain it safely from multiple orchestrator instances
-- (Issue #33). 005_service_event_outbox.sql created the table with no relay —
-- this migration is additive only and does not touch already-applied files.

ALTER TABLE service_event_outbox
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Relay poll query filters on (status, next_attempt_at); the original
-- (status, created_at) index from 005 remains useful for FIFO ordering within
-- a status but doesn't serve the backoff-aware poll predicate.
CREATE INDEX IF NOT EXISTS idx_service_event_outbox_status_next_attempt
  ON service_event_outbox(status, next_attempt_at);

-- Down migration (manual rollback)
-- DROP INDEX IF EXISTS idx_service_event_outbox_status_next_attempt;
-- ALTER TABLE service_event_outbox
--   DROP COLUMN IF EXISTS updated_at,
--   DROP COLUMN IF EXISTS published_at,
--   DROP COLUMN IF EXISTS next_attempt_at,
--   DROP COLUMN IF EXISTS last_error,
--   DROP COLUMN IF EXISTS attempts;
