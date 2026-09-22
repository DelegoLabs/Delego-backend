CREATE TABLE IF NOT EXISTS wallet_signing_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL,
  tx_hash VARCHAR(128),
  status VARCHAR(32) NOT NULL CHECK (status IN ('SUCCESS', 'FAILURE')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wallet_signing_audit_wallet_id ON wallet_signing_audit_logs(wallet_id);
