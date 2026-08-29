-- Migration: 021_workflow_timeout_analytics
-- Description: Timeout analytics and escalation tracking (#145)

CREATE TABLE IF NOT EXISTS workflow_timeout_events (
  id SERIAL PRIMARY KEY,
  workflow_id VARCHAR(128) NOT NULL,
  workflow_type VARCHAR(64) NOT NULL,
  current_step VARCHAR(64) NOT NULL,
  timeout_type VARCHAR(16) NOT NULL CHECK (timeout_type IN ('step', 'workflow')),
  configured_timeout_ms BIGINT NOT NULL,
  elapsed_ms BIGINT NOT NULL,
  action VARCHAR(16) NOT NULL CHECK (action IN ('alerted', 'compensated', 'extended', 'notified')),
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_timeout_events_workflow_type
  ON workflow_timeout_events(workflow_type);

CREATE INDEX IF NOT EXISTS idx_timeout_events_triggered_at
  ON workflow_timeout_events(triggered_at DESC);

CREATE INDEX IF NOT EXISTS idx_timeout_events_action
  ON workflow_timeout_events(action);

CREATE TABLE IF NOT EXISTS workflow_timeout_configs (
  id SERIAL PRIMARY KEY,
  workflow_type VARCHAR(64) NOT NULL UNIQUE,
  step_timeouts JSONB NOT NULL DEFAULT '{}',
  workflow_timeout_ms BIGINT NOT NULL DEFAULT 2592000000,
  escalation_steps JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Down migration (manual rollback)
-- DROP INDEX IF EXISTS idx_timeout_events_action;
-- DROP INDEX IF EXISTS idx_timeout_events_triggered_at;
-- DROP INDEX IF EXISTS idx_timeout_events_workflow_type;
-- DROP TABLE IF EXISTS workflow_timeout_configs;
-- DROP TABLE IF EXISTS workflow_timeout_events;
