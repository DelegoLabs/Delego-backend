-- Migration: 023_multi_currency
-- Description: Multi-currency support with path payments and FX rates

-- Supported currencies table
CREATE TABLE IF NOT EXISTS supported_currencies (
  code VARCHAR(12) PRIMARY KEY,
  issuer VARCHAR(56) NOT NULL,
  asset_type VARCHAR(10) NOT NULL CHECK (asset_type IN ('native', 'issued')),
  decimals SMALLINT NOT NULL DEFAULT 7 CHECK (decimals BETWEEN 0 AND 9),
  fx_provider VARCHAR(50) NOT NULL DEFAULT 'stellar_lumen',
  settlement_enabled BOOLEAN NOT NULL DEFAULT true,
  compliance_flags TEXT[] NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- FX rates table
CREATE TABLE IF NOT EXISTS fx_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency VARCHAR(12) NOT NULL,
  quote_currency VARCHAR(12) NOT NULL,
  rate NUMERIC(24, 12) NOT NULL,
  source VARCHAR(50) NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  spread NUMERIC(12, 6) NOT NULL DEFAULT 0.005,
  mid_rate NUMERIC(24, 12) NOT NULL,
  bid NUMERIC(24, 12) NOT NULL,
  ask NUMERIC(24, 12) NOT NULL,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (base_currency, quote_currency)
);

-- Multi-currency payments table
CREATE TABLE IF NOT EXISTS multi_currency_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_currency VARCHAR(12) NOT NULL,
  source_amount NUMERIC(24, 12) NOT NULL,
  destination_currency VARCHAR(12) NOT NULL,
  destination_amount NUMERIC(24, 12) NOT NULL,
  fx_rate_id UUID NOT NULL,
  fx_rate_data JSONB NOT NULL,
  conversion_path JSONB NOT NULL,
  settlement_currency VARCHAR(12) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'converting', 'settled', 'failed', 'cancelled')),
  settlement_status VARCHAR(20),
  stellar_transaction_hash VARCHAR(64),
  path_payment_id VARCHAR(64),
  source_address VARCHAR(56) NOT NULL,
  destination_address VARCHAR(56) NOT NULL,
  destination_min NUMERIC(24, 12),
  failed_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'
);

-- Currency exposures table
CREATE TABLE IF NOT EXISTS currency_exposures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  currency VARCHAR(12) NOT NULL UNIQUE,
  gross_amount NUMERIC(24, 12) NOT NULL,
  net_amount NUMERIC(24, 12) NOT NULL,
  unrealized_pnl NUMERIC(24, 12) NOT NULL DEFAULT 0,
  hedge_ratio NUMERIC(6, 4) NOT NULL DEFAULT 0,
  var95 NUMERIC(24, 12) NOT NULL,
  var99 NUMERIC(24, 12) NOT NULL,
  margin_requirement NUMERIC(24, 12) NOT NULL,
  collateral_required NUMERIC(24, 12) NOT NULL,
  exposure_date TIMESTAMPTZ NOT NULL,
  hedge_status VARCHAR(20) NOT NULL DEFAULT 'unhedged' CHECK (hedge_status IN ('unhedged', 'partially_hedged', 'fully_hedged')),
  last_calculated TIMESTAMPTZ DEFAULT NOW()
);

-- Currency settlements table
CREATE TABLE IF NOT EXISTS currency_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  currency VARCHAR(12) NOT NULL,
  total_in NUMERIC(24, 12) NOT NULL,
  total_out NUMERIC(24, 12) NOT NULL,
  net_amount NUMERIC(24, 12) NOT NULL,
  settlement_date TIMESTAMPTZ NOT NULL,
  ledger_sequence BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  transactions VARCHAR(64)[] NOT NULL DEFAULT '{}',
  failed_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ
);

-- Indexes for supported_currencies
CREATE INDEX IF NOT EXISTS idx_supported_currencies_code ON supported_currencies(code);
CREATE INDEX IF NOT EXISTS idx_supported_currencies_issuer ON supported_currencies(issuer);
CREATE INDEX IF NOT EXISTS idx_supported_currencies_asset_type ON supported_currencies(asset_type);
CREATE INDEX IF NOT EXISTS idx_supported_currencies_settlement_enabled ON supported_currencies(settlement_enabled);
CREATE INDEX IF NOT EXISTS idx_supported_currencies_enabled ON supported_currencies(enabled);

-- Indexes for fx_rates
CREATE INDEX IF NOT EXISTS idx_fx_rates_base_quote ON fx_rates(base_currency, quote_currency);
CREATE INDEX IF NOT EXISTS idx_fx_rates_valid_until ON fx_rates(valid_until);
CREATE INDEX IF NOT EXISTS idx_fx_rates_source ON fx_rates(source);

-- Indexes for multi_currency_payments
CREATE INDEX IF NOT EXISTS idx_multi_currency_payments_source_dest ON multi_currency_payments(source_currency, destination_currency);
CREATE INDEX IF NOT EXISTS idx_multi_currency_payments_status ON multi_currency_payments(status);
CREATE INDEX IF NOT EXISTS idx_multi_currency_payments_created_at ON multi_currency_payments(created_at);
CREATE INDEX IF NOT EXISTS idx_multi_currency_payments_stellar_hash ON multi_currency_payments(stellar_transaction_hash);
CREATE INDEX IF NOT EXISTS idx_multi_currency_payments_source ON multi_currency_payments(source_address);
CREATE INDEX IF NOT EXISTS idx_multi_currency_payments_dest ON multi_currency_payments(destination_address);

-- Indexes for currency_exposures
CREATE INDEX IF NOT EXISTS idx_currency_exposures_currency ON currency_exposures(currency);
CREATE INDEX IF NOT EXISTS idx_currency_exposures_date ON currency_exposures(exposure_date);
CREATE INDEX IF NOT EXISTS idx_currency_exposures_hedge_status ON currency_exposures(hedge_status);

-- Indexes for currency_settlements
CREATE INDEX IF NOT EXISTS idx_currency_settlements_currency_date ON currency_settlements(currency, settlement_date);
CREATE INDEX IF NOT EXISTS idx_currency_settlements_status ON currency_settlements(status);
CREATE INDEX IF NOT EXISTS idx_currency_settlements_ledger ON currency_settlements(ledger_sequence);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_supported_currency_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to update fx_rates last_updated
CREATE OR REPLACE FUNCTION update_fx_rates_last_updated()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_updated = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to update currency_exposures last_calculated
CREATE OR REPLACE FUNCTION update_currency_exposures_last_calculated()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_calculated = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers
CREATE TRIGGER update_supported_currencies_updated_at
  BEFORE UPDATE ON supported_currencies
  FOR EACH ROW
  EXECUTE FUNCTION update_supported_currency_updated_at();

CREATE TRIGGER update_fx_rates_last_updated
  BEFORE UPDATE ON fx_rates
  FOR EACH ROW
  EXECUTE FUNCTION update_fx_rates_last_updated();

CREATE TRIGGER update_currency_exposures_last_calculated
  BEFORE UPDATE ON currency_exposures
  FOR EACH ROW
  EXECUTE FUNCTION update_currency_exposures_last_calculated();

-- Add comments for documentation
COMMENT ON TABLE supported_currencies IS 'Configuration for supported currencies in the payment system';
COMMENT ON TABLE fx_rates IS 'FX rates for multi-currency payment conversion';
COMMENT ON TABLE multi_currency_payments IS 'Multi-currency payments with path payment support';
COMMENT ON TABLE currency_exposures IS 'Currency exposure and risk metrics';
COMMENT ON TABLE currency_settlements IS 'Currency settlement records';

COMMENT ON COLUMN supported_currencies.compliance_flags IS 'Compliance requirements (KYC, AML, etc.)';
COMMENT ON COLUMN fx_rates.spread IS 'Spread applied to the rate';
COMMENT ON COLUMN fx_rates.conversion_path IS 'Path payment route';
