-- Migration: 063_cart_sync.sql
-- Issue: #574 — Cart sync endpoint with optimistic concurrency control
-- Description: Adds the carts + cart_items tables that back
--              POST /api/v1/cart/sync.
--
--              carts.version is the server-side revision counter. It is bumped
--              on every successful sync and is what a client echoes back as
--              `clientVersion`, which is how the gateway tells a fresh
--              snapshot apart from a stale one.
--
--              cart_items.revision records the cart version at which each line
--              was last changed. That per-line revision is what lets the merge
--              distinguish "this client never saw the line" (keep it) from
--              "this client saw the line and dropped it" (remove it).
--
--              A line with quantity = 0 is a tombstone: the line was removed,
--              but the tombstone is kept so a stale device cannot resurrect
--              an item the buyer already deleted.

CREATE TABLE IF NOT EXISTS carts (
  id          VARCHAR(64) PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version     INTEGER     NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cart lookup by owner (e.g. "list my carts").
CREATE INDEX IF NOT EXISTS idx_carts_user_id
  ON carts (user_id);

CREATE TABLE IF NOT EXISTS cart_items (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id           VARCHAR(64)  NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  merchant_id       VARCHAR(64)  NOT NULL,
  product_id        VARCHAR(64)  NOT NULL,
  -- Empty string means "no variant"; kept non-null so the line identity is a
  -- plain (cart_id, merchant_id, product_id, sku_id) unique key.
  sku_id            VARCHAR(64)  NOT NULL DEFAULT '',
  -- 0 marks a tombstone (the line was removed).
  quantity          INTEGER      NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  -- Last-write-wins timestamp of the line.
  client_updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Cart version at which the line was last changed.
  revision          INTEGER      NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One row per (cart, merchant, product, sku).
CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_items_line
  ON cart_items (cart_id, merchant_id, product_id, sku_id);

-- Fast "load every line of this cart" lookups.
CREATE INDEX IF NOT EXISTS idx_cart_items_cart_id
  ON cart_items (cart_id);

-- ── Down migration ─────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS idx_cart_items_cart_id;
-- DROP INDEX IF EXISTS idx_cart_items_line;
-- DROP TABLE IF EXISTS cart_items;
-- DROP INDEX IF EXISTS idx_carts_user_id;
-- DROP TABLE IF EXISTS carts;
