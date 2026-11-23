-- Migration: 060_review_helpful_votes
-- Issues: #521 Public Product Review Feed
-- Description: Tracks "helpful" votes per review with IP/wallet deduplication.

CREATE TABLE IF NOT EXISTS review_helpful_votes (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id    UUID        NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  voter_ip     INET,
  voter_wallet VARCHAR(56),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_helpful_vote_ip
    UNIQUE (review_id, voter_ip),
  CONSTRAINT uq_helpful_vote_wallet
    UNIQUE (review_id, voter_wallet),
  CONSTRAINT chk_helpful_voter_identity
    CHECK (voter_ip IS NOT NULL OR voter_wallet IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_helpful_votes_review_id
  ON review_helpful_votes (review_id);

-- Denormalized count on reviews table for O(1) read performance.
ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS helpful_count INTEGER NOT NULL DEFAULT 0;

-- Shipping matrices table for multi-merchant price comparison (#531).
-- Stores per-merchant flat shipping fees keyed by destination country.
CREATE TABLE IF NOT EXISTS merchant_shipping_matrices (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     UUID        NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  dest_country    VARCHAR(2)  NOT NULL,
  fee_stroops     BIGINT      NOT NULL CHECK (fee_stroops >= 0),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_shipping_matrix_merchant_country
    UNIQUE (merchant_id, dest_country)
);

CREATE INDEX IF NOT EXISTS idx_shipping_matrix_merchant
  ON merchant_shipping_matrices (merchant_id);
