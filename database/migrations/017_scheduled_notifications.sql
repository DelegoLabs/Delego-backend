-- Migration: 017_scheduled_notifications
-- Description: Durable storage for scheduled/recurring notifications (Issue #59),
--   so the scheduler survives restarts instead of losing all pending work from the
--   in-memory store (apps/backend/notifications/src/scheduler/store.ts).

CREATE TABLE IF NOT EXISTS scheduled_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  template_name VARCHAR(255) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  run_at TIMESTAMPTZ NOT NULL,
  cron_expression VARCHAR(100),
  timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
  end_at TIMESTAMPTZ,
  status VARCHAR(32) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'cancelled', 'dispatched', 'failed')),
  run_count INTEGER NOT NULL DEFAULT 0,
  max_runs INTEGER,
  last_dispatched_at TIMESTAMPTZ,
  -- Distributed-locking columns (Issue #59): a poller claims a row by writing its own
  -- id + a lease expiry before dispatching, mirroring the lease pattern in
  -- apps/backend/orchestrator/src/saga/types.ts's SagaRecord.claimExpiresAt — a second
  -- poller instance may only reclaim a row once claim_expires_at is null or in the past.
  claimed_by VARCHAR(128),
  claim_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The poller's core query is "find pending rows due now, unclaimed or with an expired
-- claim" — this partial index keeps that scan cheap as the table grows, since dispatched/
-- cancelled/failed rows (the overwhelming majority over time) are excluded entirely.
CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_due
  ON scheduled_notifications(run_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_user
  ON scheduled_notifications(user_id, created_at DESC);

-- Down migration (manual rollback)
-- DROP INDEX IF EXISTS idx_scheduled_notifications_user;
-- DROP INDEX IF EXISTS idx_scheduled_notifications_due;
-- DROP TABLE IF EXISTS scheduled_notifications;
