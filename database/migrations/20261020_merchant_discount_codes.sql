-- Migration: 20261020_merchant_discount_codes
-- Description: Implement database table and indexes for merchant promotional discount codes

CREATE TABLE IF NOT EXISTS merchant_discount_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id VARCHAR(64) NOT NULL,
    code VARCHAR(32) NOT NULL,
    discount_type VARCHAR(16) NOT NULL CHECK (discount_type IN ('percentage', 'fixed_stroops')),
    discount_value BIGINT NOT NULL CHECK (discount_value > 0),
    min_order_stroops BIGINT NOT NULL DEFAULT 0,
    max_discount_stroops BIGINT,
    max_uses INTEGER,
    current_uses INTEGER NOT NULL DEFAULT 0,
    valid_from TIMESTAMPTZ NOT NULL,
    valid_until TIMESTAMPTZ NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_valid_dates CHECK (valid_until > valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_discount_merchant_code ON merchant_discount_codes(merchant_id, UPPER(code));
