-- Rollback migration: 022_account_recovery
-- Description: Drop recovery tables

-- Drop triggers
DROP TRIGGER IF EXISTS update_recovery_configs_updated_at ON recovery_configs;

-- Drop function
DROP FUNCTION IF EXISTS update_recovery_config_updated_at();

-- Drop tables
DROP TABLE IF EXISTS recovery_challenges;
DROP TABLE IF EXISTS recovery_audit_logs;
DROP TABLE IF EXISTS recovery_requests;
DROP TABLE IF EXISTS recovery_configs;
