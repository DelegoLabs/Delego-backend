-- Rollback migration: 021_payment_method_vault
-- Description: Drop payment method vault tables

-- Drop triggers
DROP TRIGGER IF EXISTS update_payment_methods_updated_at ON payment_methods;
DROP TRIGGER IF EXISTS update_payment_audit_logs_timestamp ON payment_audit_logs;

-- Drop function
DROP FUNCTION IF EXISTS update_updated_at_column();

-- Drop tables
DROP TABLE IF EXISTS payment_audit_logs;
DROP TABLE IF EXISTS payment_methods;
