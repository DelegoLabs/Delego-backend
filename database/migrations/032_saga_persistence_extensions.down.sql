-- Rollback for migration 021 (Issue #48)

DROP TABLE IF EXISTS saga_events;

ALTER TABLE saga_executions
  DROP COLUMN IF EXISTS expires_at;

ALTER TABLE saga_executions
  DROP COLUMN IF EXISTS correlation_id;

ALTER TABLE saga_executions
  DROP COLUMN IF EXISTS workflow_type;
