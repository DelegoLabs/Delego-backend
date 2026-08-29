-- Rollback migration: 023_multi_currency
-- Description: Drop multi-currency tables

-- Drop triggers
DROP TRIGGER IF EXISTS update_supported_currencies_updated_at ON supported_currencies;
DROP TRIGGER IF EXISTS update_fx_rates_last_updated ON fx_rates;
DROP TRIGGER IF EXISTS update_currency_exposures_last_calculated ON currency_exposures;

-- Drop functions
DROP FUNCTION IF EXISTS update_supported_currency_updated_at();
DROP FUNCTION IF EXISTS update_fx_rates_last_updated();
DROP FUNCTION IF EXISTS update_currency_exposures_last_calculated();

-- Drop tables
DROP TABLE IF EXISTS currency_settlements;
DROP TABLE IF EXISTS currency_exposures;
DROP TABLE IF EXISTS multi_currency_payments;
DROP TABLE IF EXISTS fx_rates;
DROP TABLE IF EXISTS supported_currencies;
