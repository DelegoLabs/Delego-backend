-- Migration: 064_escrow_yield_distributions
-- Description: Tables for the Blend Yield Accrual Event Listener (Issue #606).
--              Records per-event yield distributions for long-duration
--              escrows staked in Blend pools, split between buyer and
--              merchant shares, and tracks disbursement.

CREATE TABLE IF NOT EXISTS escrow_yield_distributions (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id                    VARCHAR(64) NOT NULL,
  order_id                     UUID REFERENCES orders(id) ON DELETE SET NULL,
  pool_id                      VARCHAR(64) NOT NULL,
  accrued_yield_stroops        BIGINT NOT NULL,
  buyer_yield_share_stroops    BIGINT NOT NULL,
  merchant_yield_share_stroops BIGINT NOT NULL,
  event_timestamp              TIMESTAMPTZ NOT NULL,
  tx_hash                      VARCHAR(64),
  disbursed                    BOOLEAN NOT NULL DEFAULT FALSE,
  disbursed_at                 TIMESTAMPTZ,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One snapshot per escrow per event timestamp — makes re-delivery of the
-- same `YieldDistributed` event (e.g. consumer-group redelivery) idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_escrow_yield_distributions_escrow_ts
  ON escrow_yield_distributions (escrow_id, event_timestamp);

CREATE INDEX IF NOT EXISTS idx_escrow_yield_distributions_order_id
  ON escrow_yield_distributions (order_id);

CREATE INDEX IF NOT EXISTS idx_escrow_yield_distributions_undisbursed
  ON escrow_yield_distributions (escrow_id)
  WHERE disbursed = FALSE;

COMMENT ON TABLE escrow_yield_distributions IS
  'Per-event Blend yield accrual records for staked escrows, split between buyer and merchant shares. Written by the CDC Blend yield event listener.';

-- ── Down migration ─────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS idx_escrow_yield_distributions_undisbursed;
-- DROP INDEX IF EXISTS idx_escrow_yield_distributions_order_id;
-- DROP INDEX IF EXISTS idx_escrow_yield_distributions_escrow_ts;
-- DROP TABLE IF EXISTS escrow_yield_distributions;
