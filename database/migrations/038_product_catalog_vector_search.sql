-- Migration 038: Product catalog with pgvector embeddings
-- Issue #263: enables semantic vector search on the products table.
--
-- Requires the pgvector extension (CREATE EXTENSION IF NOT EXISTS vector).

-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Merchants table (if not already present from earlier migrations)
CREATE TABLE IF NOT EXISTS merchants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stellar_address TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  reputation_score NUMERIC(5,2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Products table with embedding column
CREATE TABLE IF NOT EXISTS products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  category        TEXT,
  price_stroops   NUMERIC(20,0) NOT NULL,
  asset_code      TEXT NOT NULL DEFAULT 'USDC',
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'unlisted', 'deleted')),
  in_stock        BOOLEAN NOT NULL DEFAULT TRUE,
  -- 1536-dimensional vector for text-embedding-3-small
  embedding       vector(1536),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast cosine similarity search
CREATE INDEX IF NOT EXISTS products_embedding_hnsw_idx
  ON products
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Partial index: only index active, in-stock products to keep the index small
CREATE INDEX IF NOT EXISTS products_active_in_stock_idx
  ON products (merchant_id, category, asset_code)
  WHERE status = 'active' AND in_stock = TRUE;

-- Agent tool audit log
-- Issue #262: persists every agent tool invocation for compliance and debugging.
CREATE TABLE IF NOT EXISTS agent_tool_audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name       TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  delegation_id   TEXT,
  input           JSONB NOT NULL DEFAULT '{}',
  output          JSONB,
  success         BOOLEAN NOT NULL,
  error           TEXT,
  duration_ms     INTEGER NOT NULL,
  executed_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_tool_audit_user_idx
  ON agent_tool_audit_log (user_id, executed_at DESC);

CREATE INDEX IF NOT EXISTS agent_tool_audit_tool_idx
  ON agent_tool_audit_log (tool_name, executed_at DESC);
