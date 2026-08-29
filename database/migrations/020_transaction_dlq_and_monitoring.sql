-- Migration: Transaction Dead Letter Queue
-- Issue #143

CREATE TABLE IF NOT EXISTS transaction_dead_letter_queue (
  id TEXT PRIMARY KEY,
  original_job_id TEXT NOT NULL,
  request JSONB NOT NULL,
  failure_code TEXT NOT NULL,
  failure_message TEXT NOT NULL,
  failure_category TEXT NOT NULL CHECK (failure_category IN ('transient', 'permanent', 'unknown')),
  failure_retryable BOOLEAN NOT NULL DEFAULT FALSE,
  failure_tx_hash TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_retry_at TIMESTAMPTZ,
  replay_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'retrying', 'replayed', 'archived', 'discarded'))
);

CREATE INDEX IF NOT EXISTS idx_dlq_status ON transaction_dead_letter_queue(status);
CREATE INDEX IF NOT EXISTS idx_dlq_category ON transaction_dead_letter_queue(failure_category);
CREATE INDEX IF NOT EXISTS idx_dlq_created_at ON transaction_dead_letter_queue(created_at);
CREATE INDEX IF NOT EXISTS idx_dlq_next_retry ON transaction_dead_letter_queue(next_retry_at) WHERE status = 'pending';

-- Sequence reservation audit trail
CREATE TABLE IF NOT EXISTS sequence_reservation_audit (
  id SERIAL PRIMARY KEY,
  account TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('reserve', 'consume', 'release', 'expire', 'force_release', 'pre_warm', 'gap_detected')),
  lease_id TEXT,
  sequence TEXT,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_seq_audit_account ON sequence_reservation_audit(account);
CREATE INDEX IF NOT EXISTS idx_seq_audit_created_at ON sequence_reservation_audit(created_at);

-- Sequence gap tracking
CREATE TABLE IF NOT EXISTS sequence_gaps (
  id SERIAL PRIMARY KEY,
  account TEXT NOT NULL,
  expected_sequence TEXT NOT NULL,
  actual_sequence TEXT NOT NULL,
  gap_size INTEGER NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_seq_gaps_account ON sequence_gaps(account);
CREATE INDEX IF NOT EXISTS idx_seq_gaps_resolved ON sequence_gaps(resolved);

-- Simulation cache metadata (optional persistence)
CREATE TABLE IF NOT EXISTS simulation_cache_entries (
  key TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  method TEXT NOT NULL,
  contract_version TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sim_cache_contract ON simulation_cache_entries(contract_id);
CREATE INDEX IF NOT EXISTS idx_sim_cache_expires ON simulation_cache_entries(expires_at);
