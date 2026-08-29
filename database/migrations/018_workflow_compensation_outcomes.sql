-- Migration: 018_workflow_compensation_outcomes
-- Description: Persists the final outcome of a purchase workflow's escrow
-- compensation run on the workflow record itself (Issue #35), distinct from
-- the per-step audit trail in workflow_transition_audit (008). One row per
-- workflowId — a retried compensation run upserts in place so the record
-- always reflects the latest attempt's outcome.

CREATE TABLE IF NOT EXISTS workflow_compensation_outcomes (
  workflow_id VARCHAR(255) PRIMARY KEY,
  status VARCHAR(32) NOT NULL CHECK (status IN ('success', 'partial_failure', 'escrow_stuck')),
  compensated_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  failed_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  cause TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_workflow_compensation_outcomes_status
  ON workflow_compensation_outcomes(status);

-- Down migration (manual rollback)
-- DROP INDEX IF EXISTS idx_workflow_compensation_outcomes_status;
-- DROP TABLE IF EXISTS workflow_compensation_outcomes;
