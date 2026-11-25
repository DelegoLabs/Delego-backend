-- Migration: 066_merchant_webhooks
-- Description: Creates tables for merchant webhook management and delivery logging.
--              Enables merchants to configure outbound webhooks, inspect delivery
--              logs, and replay failed deliveries.

-- Webhooks table: stores merchant webhook configurations
CREATE TABLE IF NOT EXISTS webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT[] NOT NULL DEFAULT '{}',
  headers JSONB NOT NULL DEFAULT '{}',
  retry_policy JSONB NOT NULL DEFAULT '{"maxAttempts":5,"initialDelayMs":1000,"maxDelayMs":60000,"backoffMultiplier":2}',
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for merchant webhook lookups
CREATE INDEX IF NOT EXISTS idx_webhooks_merchant_id
  ON webhooks (merchant_id, created_at DESC);

-- Index for active webhooks
CREATE INDEX IF NOT EXISTS idx_webhooks_status
  ON webhooks (status)
  WHERE status = 'active';

-- Webhook deliveries table: stores delivery attempts with full payload and response
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'dead_letter')),
  response_status INTEGER,
  response_headers JSONB,
  response_body TEXT,
  error TEXT,
  next_retry_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Index for webhook delivery lookups
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id
  ON webhook_deliveries (webhook_id, sent_at DESC);

-- Index for event lookups
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event_id
  ON webhook_deliveries (event_id);

-- Index for failed deliveries
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_failed
  ON webhook_deliveries (webhook_id, sent_at DESC)
  WHERE status IN ('failed', 'dead_letter');

-- Index for pending retries
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending_retry
  ON webhook_deliveries (next_retry_at)
  WHERE status = 'failed' AND next_retry_at IS NOT NULL;

-- Update webhook_delivery_logs to include response headers and full payload
-- (This extends the existing forensic logs table)
ALTER TABLE webhook_delivery_logs
  ADD COLUMN IF NOT EXISTS response_headers JSONB,
  ADD COLUMN IF NOT EXISTS request_headers JSONB,
  ADD COLUMN IF NOT EXISTS full_payload JSONB;

-- Index for delivery log lookups by endpoint
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_logs_endpoint_created
  ON webhook_delivery_logs (endpoint_id, created_at DESC);

COMMENT ON TABLE webhooks IS
  'Merchant webhook configurations for outbound event notifications';

COMMENT ON TABLE webhook_deliveries IS
  'Webhook delivery attempts with full payload, response details, and retry state';

COMMENT ON TABLE webhook_delivery_logs IS
  'Forensic logs of webhook delivery attempts for debugging and compliance';

-- ── Down migration ─────────────────────────────────────────────────────────────
-- ALTER TABLE webhook_delivery_logs DROP COLUMN IF EXISTS full_payload;
-- ALTER TABLE webhook_delivery_logs DROP COLUMN IF EXISTS request_headers;
-- ALTER TABLE webhook_delivery_logs DROP COLUMN IF EXISTS response_headers;
-- DROP TABLE IF EXISTS webhook_deliveries;
-- DROP TABLE IF EXISTS webhooks;
