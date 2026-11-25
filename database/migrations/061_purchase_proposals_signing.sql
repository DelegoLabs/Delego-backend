-- Migration: 061_purchase_proposals_signing
-- Issue: #534 Signed Purchase Proposal Generation
-- Description: Extends purchase_proposals with cryptographic signing columns
--              required for tamper-proof agent-generated proposals.

ALTER TABLE purchase_proposals
  ADD COLUMN IF NOT EXISTS agent_id        UUID        REFERENCES delegations(id),
  ADD COLUMN IF NOT EXISTS buyer_address   VARCHAR(64),
  ADD COLUMN IF NOT EXISTS escrow_salt     VARCHAR(128),
  ADD COLUMN IF NOT EXISTS proposal_hash   VARCHAR(64),
  ADD COLUMN IF NOT EXISTS agent_signature VARCHAR(256);

-- Partial index: quickly look up unsigned proposals that need signing.
CREATE INDEX IF NOT EXISTS idx_purchase_proposals_unsigned
  ON purchase_proposals (created_at)
  WHERE proposal_hash IS NULL;

-- ── Down migration ─────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS idx_purchase_proposals_unsigned;
-- ALTER TABLE purchase_proposals
--   DROP COLUMN IF EXISTS agent_signature,
--   DROP COLUMN IF EXISTS proposal_hash,
--   DROP COLUMN IF EXISTS escrow_salt,
--   DROP COLUMN IF EXISTS buyer_address,
--   DROP COLUMN IF EXISTS agent_id;
