-- Migration: 063_contract_upgrade_listener
-- Description: Tables for the Contract Upgrade Event Listener (Issue #603).
--              Tracks governance-approved WASM hashes, contract configuration
--              records, and withdrawal pause state for security enforcement.

-- ─────────────────────────────────────────────────────────────────────────────
-- Governance-approved WASM bytecode hashes
-- Each row represents a contract version that has been approved by the
-- governance multisig. The listener verifies upgrade events against this table.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contract_approved_wasm_hashes (
  id BIGSERIAL PRIMARY KEY,
  contract_address VARCHAR(255) NOT NULL,
  wasm_hash VARCHAR(64) NOT NULL,
  approved_by VARCHAR(255) NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL,
  description TEXT,
  governance_proposal_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (contract_address, wasm_hash)
);

CREATE INDEX IF NOT EXISTS idx_contract_approved_wasm_hashes_contract
  ON contract_approved_wasm_hashes (contract_address);

CREATE INDEX IF NOT EXISTS idx_contract_approved_wasm_hashes_approved_at
  ON contract_approved_wasm_hashes (approved_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Contract configuration records
-- Tracks the current deployed WASM hash, upgrade history, and operational
-- status for each monitored contract.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contract_config_records (
  contract_address VARCHAR(255) PRIMARY KEY,
  current_wasm_hash VARCHAR(64) NOT NULL,
  last_upgrade_ledger BIGINT NOT NULL,
  last_upgrade_tx_hash VARCHAR(64) NOT NULL,
  last_upgrade_at TIMESTAMPTZ NOT NULL,
  upgrade_count BIGINT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contract_config_records_status
  ON contract_config_records (status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Withdrawal pause state
-- When an unverified contract upgrade is detected, automated withdrawals are
-- paused for that contract. This table tracks the pause state and allows
-- manual resumption after governance verification.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contract_withdrawal_pause_state (
  contract_address VARCHAR(255) PRIMARY KEY,
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  paused_at TIMESTAMPTZ,
  paused_by VARCHAR(255),
  pause_reason TEXT,
  resumed_at TIMESTAMPTZ,
  resumed_by VARCHAR(255),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Down migration
-- ─────────────────────────────────────────────────────────────────────────────

-- DROP INDEX IF EXISTS idx_contract_withdrawal_pause_state_updated_at;
-- DROP TABLE IF EXISTS contract_withdrawal_pause_state;
-- DROP INDEX IF EXISTS idx_contract_config_records_status;
-- DROP TABLE IF EXISTS contract_config_records;
-- DROP INDEX IF EXISTS idx_contract_approved_wasm_hashes_approved_at;
-- DROP INDEX IF EXISTS idx_contract_approved_wasm_hashes_contract;
-- DROP TABLE IF EXISTS contract_approved_wasm_hashes;