-- Rollback for 20261120120000_fx_rate_snapshots.sql
DROP INDEX IF EXISTS idx_fx_snapshots_currencies_time;
DROP TABLE IF EXISTS fx_rate_snapshots;
