-- Migration: 023_notification_preference_center
-- Description: Notification preference center (Issue #115)
--   - Extends notification_preferences with org_id + JSONB preference document
--   - Org-level defaults for preference inheritance (org -> user)
--   - Migration history for the preference migration tool

ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS org_id UUID,
  ADD COLUMN IF NOT EXISTS preferences JSONB,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_notification_preferences_org
  ON notification_preferences(org_id)
  WHERE org_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS org_notification_preferences (
  org_id UUID PRIMARY KEY,
  preferences JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 2,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_org_notification_preferences_updated
  ON org_notification_preferences(updated_at);

CREATE TABLE IF NOT EXISTS preference_migrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  changes JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_preference_migrations_user
  ON preference_migrations(user_id);
