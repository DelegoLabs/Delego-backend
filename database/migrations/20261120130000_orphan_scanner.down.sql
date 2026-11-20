-- Rollback for 20261120130000_orphan_scanner.sql
DROP INDEX IF EXISTS idx_orphan_quarantine_status;
DROP INDEX IF EXISTS idx_orphan_quarantine_tx_hash;
DROP TABLE IF EXISTS orphaned_transaction_quarantine;
DROP TABLE IF EXISTS orphan_scanner_checkpoints;
