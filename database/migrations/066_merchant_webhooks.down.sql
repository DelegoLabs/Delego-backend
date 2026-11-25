-- Down migration for 066_merchant_webhooks
ALTER TABLE webhook_delivery_logs DROP COLUMN IF EXISTS full_payload;
ALTER TABLE webhook_delivery_logs DROP COLUMN IF EXISTS request_headers;
ALTER TABLE webhook_delivery_logs DROP COLUMN IF EXISTS response_headers;
DROP TABLE IF EXISTS webhook_deliveries;
DROP TABLE IF EXISTS webhooks;
