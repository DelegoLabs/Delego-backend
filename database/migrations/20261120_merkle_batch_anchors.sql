-- Migration: 20261120_merkle_batch_anchors
-- Description: Tracks batch Merkle-tree anchors of the audit log, published
-- to the Stellar ledger as a 32-byte hash memo on a zero-value transaction
-- (Issue #613). Each row covers one contiguous `audit_log.sequence_num`
-- range (default batch size: 1,000 entries — see
-- packages/utils/src/audit/merkleTree.ts).
--
-- `leaf_hashes` stores the batch's ordered entry_hash values so
-- `apps/backend/src/workers/auditAnchorWorker.ts` can regenerate an
-- inclusion proof for any individual entry in the batch without
-- re-querying (and depending on the retention of) `audit_log` itself.

CREATE TABLE IF NOT EXISTS merkle_batch_anchors (
  batch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merkle_root_hex CHAR(64) NOT NULL,
  leaf_count INTEGER NOT NULL CHECK (leaf_count > 0),
  start_sequence BIGINT NOT NULL,
  end_sequence BIGINT NOT NULL CHECK (end_sequence >= start_sequence),
  leaf_hashes JSONB NOT NULL,
  stellar_tx_hash CHAR(64),
  anchored_ledger BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_merkle_batch_anchors_range
  ON merkle_batch_anchors(start_sequence, end_sequence);
CREATE INDEX IF NOT EXISTS idx_merkle_batch_anchors_end_sequence
  ON merkle_batch_anchors(end_sequence DESC);
