-- Multi-merchant cart sessions, line items, and stock leases.
-- Migration: 20261020_multi_merchant_cart_sessions

BEGIN;

CREATE TABLE IF NOT EXISTS cart_sessions (
    id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
    buyer_id VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    currency VARCHAR(12) NOT NULL DEFAULT 'XLM',
    created_at TIMESTAMPZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPZ NOT NULL
);

CREATE TABLE IF NOT EXISTS cart_line_items (
    id UUID PRIMARY KEY DEFAULT GEN_RANDOM_UUID(),
    cart_id UUID NOT NULL REFERENCES cart_sessions(id) ON DELETE CASCADE,
    merchant_id VARCHAR(64) NOT NULL,
    product_id VARCHAR(64) NOT NULL,
    sku_id VARCHAR(64),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_stroops BIGINT NOT NULL,
    reserved_until TIMESTAMPZ,
    created_at TIMESTAMPZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cart_line_items_merchant
    ON cart_line_items(merchant_id, product_id);

COMMIT;
