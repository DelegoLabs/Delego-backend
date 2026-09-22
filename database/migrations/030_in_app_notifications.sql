-- Migration: 016_in_app_notifications
-- Description: Durable in-app notification center records (issues #58/#60)

CREATE TABLE IF NOT EXISTS in_app_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  category VARCHAR(32) NOT NULL CHECK (category IN ('transaction', 'system', 'marketing', 'security')),
  type VARCHAR(100) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  action_url TEXT,
  action_label VARCHAR(100),
  image_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_in_app_notifications_user_created
  ON in_app_notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_in_app_notifications_user_state
  ON in_app_notifications(user_id, read, archived, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_in_app_notifications_expiry
  ON in_app_notifications(expires_at) WHERE expires_at IS NOT NULL AND archived = FALSE;