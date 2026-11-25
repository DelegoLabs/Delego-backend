-- Multi-currency FX rate snapshot store (Issue #622).
--
-- Permanent, append-only archive of exchange rates captured hourly for tax
-- and financial-auditing purposes: the fiat value (USD, EUR, GBP, ...) of
-- XLM/USDC at the exact moment of order settlement must be reconstructable
-- indefinitely, independent of the short-lived `exchange_rate_cache` table
-- (which is a TTL'd conversion cache, not an audit trail).
CREATE TABLE IF NOT EXISTS fx_rate_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    base_currency VARCHAR(12) NOT NULL,
    quote_currency VARCHAR(12) NOT NULL,
    rate NUMERIC(18, 8) NOT NULL,
    source VARCHAR(32) NOT NULL DEFAULT 'coingecko',
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Serves both the hourly-refresh worker's "latest rate" lookup and the
-- historical point-in-time lookup (closest snapshot at or before a given
-- timestamp), each scoped to one currency pair — DESC on captured_at lets
-- both read the first matching row off the index with no extra sort step.
CREATE INDEX IF NOT EXISTS idx_fx_snapshots_currencies_time
    ON fx_rate_snapshots(base_currency, quote_currency, captured_at DESC);
