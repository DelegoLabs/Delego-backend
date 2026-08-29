-- Migration: 019_redis_pubsub_dead_letters
-- Description: Dead letter queue for Redis Pub/Sub failed deliveries (#123)

CREATE TABLE IF NOT EXISTS pubsub_dead_letters (
  id SERIAL PRIMARY KEY,
  message_id VARCHAR(128) NOT NULL,
  channel VARCHAR(256) NOT NULL,
  message_type VARCHAR(128) NOT NULL,
  payload JSONB NOT NULL,
  error TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  subscription_id VARCHAR(128) NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by VARCHAR(128)
);

CREATE INDEX IF NOT EXISTS idx_pubsub_dead_letters_channel
  ON pubsub_dead_letters(channel);

CREATE INDEX IF NOT EXISTS idx_pubsub_dead_letters_failed_at
  ON pubsub_dead_letters(failed_at DESC);

CREATE INDEX IF NOT EXISTS idx_pubsub_dead_letters_unresolved
  ON pubsub_dead_letters(resolved_at)
  WHERE resolved_at IS NULL;

-- Down migration (manual rollback)
-- DROP INDEX IF EXISTS idx_pubsub_dead_letters_unresolved;
-- DROP INDEX IF EXISTS idx_pubsub_dead_letters_failed_at;
-- DROP INDEX IF EXISTS idx_pubsub_dead_letters_channel;
-- DROP TABLE IF EXISTS pubsub_dead_letters;
