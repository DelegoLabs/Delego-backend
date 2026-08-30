-- Migration: 016_disputes
-- Description: Partial refund balance tracking on payment_records, plus dispute
-- mediation tables (disputes, evidence, immutable audit log, and per-address
-- dispute reputation) for Issue #46.

-- Cumulative partial-release / partial-refund tracking so the remaining
-- escrow balance (amount_stroops - released - refunded) can be validated
-- without re-reading on-chain state on every request.
ALTER TABLE payment_records
  ADD COLUMN IF NOT EXISTS released_amount_stroops BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunded_amount_stroops BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id VARCHAR(64) NOT NULL,
  order_id UUID REFERENCES orders(id),
  initiated_by VARCHAR(56) NOT NULL,
  reason TEXT NOT NULL,
  mediator VARCHAR(56),
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'evidence_collection', 'negotiation', 'decided', 'resolved')),
  sla_deadline TIMESTAMPTZ NOT NULL,
  escalated_at TIMESTAMPTZ,
  resolution_type VARCHAR(20)
    CHECK (resolution_type IN ('full_refund', 'partial_refund', 'release_to_seller', 'split')),
  resolution_buyer_amount BIGINT,
  resolution_seller_amount BIGINT,
  resolution_decided_by VARCHAR(56),
  resolution_decided_at TIMESTAMPTZ,
  resolution_tx_hashes JSONB,
  resolution_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disputes_escrow_id ON disputes(escrow_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);
CREATE INDEX IF NOT EXISTS idx_disputes_sla_deadline
  ON disputes(sla_deadline)
  WHERE status NOT IN ('decided', 'resolved') AND escalated_at IS NULL;

CREATE TABLE IF NOT EXISTS dispute_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL REFERENCES disputes(id),
  party VARCHAR(56) NOT NULL,
  description TEXT NOT NULL,
  files JSONB NOT NULL DEFAULT '[]',
  integrity_hash CHAR(64) NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispute_evidence_dispute_id ON dispute_evidence(dispute_id);

-- Append-only: application code must never UPDATE or DELETE rows here.
CREATE TABLE IF NOT EXISTS dispute_audit_log (
  id BIGSERIAL PRIMARY KEY,
  dispute_id UUID,
  escrow_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  actor VARCHAR(56),
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispute_audit_log_dispute_id ON dispute_audit_log(dispute_id);
CREATE INDEX IF NOT EXISTS idx_dispute_audit_log_escrow_id ON dispute_audit_log(escrow_id);
CREATE INDEX IF NOT EXISTS idx_dispute_audit_log_created_at ON dispute_audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS user_dispute_reputation (
  address VARCHAR(56) PRIMARY KEY,
  disputes_initiated INT NOT NULL DEFAULT 0,
  disputes_involved INT NOT NULL DEFAULT 0,
  disputes_resolved_favorably INT NOT NULL DEFAULT 0,
  disputes_resolved_unfavorably INT NOT NULL DEFAULT 0,
  last_dispute_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Down migration (manual rollback)
-- DROP TABLE IF EXISTS user_dispute_reputation;
-- DROP INDEX IF EXISTS idx_dispute_audit_log_created_at;
-- DROP INDEX IF EXISTS idx_dispute_audit_log_escrow_id;
-- DROP INDEX IF EXISTS idx_dispute_audit_log_dispute_id;
-- DROP TABLE IF EXISTS dispute_audit_log;
-- DROP INDEX IF EXISTS idx_dispute_evidence_dispute_id;
-- DROP TABLE IF EXISTS dispute_evidence;
-- DROP INDEX IF EXISTS idx_disputes_sla_deadline;
-- DROP INDEX IF EXISTS idx_disputes_status;
-- DROP INDEX IF EXISTS idx_disputes_escrow_id;
-- DROP TABLE IF EXISTS disputes;
-- ALTER TABLE payment_records DROP COLUMN IF EXISTS refunded_amount_stroops;
-- ALTER TABLE payment_records DROP COLUMN IF EXISTS released_amount_stroops;
