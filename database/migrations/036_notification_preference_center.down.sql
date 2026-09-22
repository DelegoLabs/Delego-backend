-- Down migration: 023_notification_preference_center
-- Description: Notification preference center (Issue #115)

DROP TABLE IF EXISTS preference_migrations;
DROP TABLE IF EXISTS org_notification_preferences;
DROP INDEX IF EXISTS idx_notification_preferences_org;

ALTER TABLE notification_preferences
  DROP COLUMN IF EXISTS version,
  DROP COLUMN IF EXISTS preferences,
  DROP COLUMN IF EXISTS org_id;
