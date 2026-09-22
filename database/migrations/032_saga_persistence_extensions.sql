-- Migration: Saga persistence extensions for crash recovery
-- Issue #48 — Durable saga state with PostgreSQL, event sourcing audit trail,
-- correlation IDs for distributed tracing, JSONB context validation, and
-- saga-level timeout detection.

-- saga_executions already exists (database/schema/002_orchestrator_sagas.sql).
-- Extend it with the fields required by #48.

ALTER TABLE saga_executions
  ADD COLUMN IF NOT EXISTS workflow_type VARCHAR(32) NOT NULL DEFAULT 'checkout'
    CHECK (workflow_type IN ('checkout', 'purchase', 'refund', 'dispute'));

ALTER TABLE saga_executions
  ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(128);

ALTER TABLE saga_executions
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- completed_steps is already JSONB (string[]); it now stores rich step objects.
-- No column type change is required — JSONB accepts the new shape.

CREATE INDEX IF NOT EXISTS idx_saga_executions_correlation_id
  ON saga_executions (correlation_id);

CREATE INDEX IF NOT EXISTS idx_saga_executions_expires_at
  ON saga_executions (expires_at)
  WHERE status IN ('running', 'compensating');

-- Event sourcing audit trail: every saga transition is appended here so the
-- full history of a saga is reconstructable after a crash or for compliance.
CREATE TABLE IF NOT EXISTS saga_events (
  id BIGSERIAL PRIMARY KEY,
  saga_id VARCHAR(128) NOT NULL,
  correlation_id VARCHAR(128),
  event_type VARCHAR(64) NOT NULL,
  from_status VARCHAR(32),
  to_status VARCHAR(32),
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saga_events_saga_id ON saga_events (saga_id);
CREATE INDEX IF NOT EXISTS idx_saga_events_correlation_id ON saga_events (correlation_id);
CREATE INDEX IF NOT EXISTS idx_saga_events_created_at ON saga_events (created_at);
