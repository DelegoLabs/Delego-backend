-- Migration: 021_payment_method_vault
-- Description: PCI DSS SAQ A-EP compliant payment method vault

-- Payment methods table
CREATE TABLE IF NOT EXISTS payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  type VARCHAR(20) NOT NULL CHECK (type IN ('card', 'bank_account', 'wallet', 'stellar_account')),
  token VARCHAR(255) NOT NULL UNIQUE,
  brand VARCHAR(50),
  last4 VARCHAR(4),
  expiry_month SMALLINT CHECK (expiry_month >= 1 AND expiry_month <= 12),
  expiry_year SMALLINT CHECK (expiry_year >= 2024),
  fingerprint VARCHAR(255) NOT NULL UNIQUE,
  network_token VARCHAR(512),
  network_token_type VARCHAR(50) CHECK (network_token_type IN ('visanet', 'mastercard-cvs', 'amex-epn', 'discover-dps')),
  network_token_expiry_month SMALLINT CHECK (network_token_expiry_month >= 1 AND network_token_expiry_month <= 12),
  network_token_expiry_year SMALLINT CHECK (network_token_expiry_year >= 2024),
  network_token_cryptogram VARCHAR(255),
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  verification_method VARCHAR(20) NOT NULL DEFAULT 'none' CHECK (verification_method IN ('none', '3ds', 'microdeposit', 'instant')),
  metadata JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'removed')),
  three_d_secure_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  three_d_secure_challenged BOOLEAN,
  three_d_secure_version VARCHAR(20),
  three_d_secure_cryptogram VARCHAR(255),
  three_d_secure_eci_flag VARCHAR(10),
  last_used_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Payment audit logs table
CREATE TABLE IF NOT EXISTS payment_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL UNIQUE,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type VARCHAR(50) NOT NULL CHECK (event_type IN (
    'payment_method_created',
    'payment_method_updated',
    'payment_method_verified',
    'payment_method_removed',
    'payment_method_tokenized',
    'payment_method_network_tokenized',
    'payment_method_3ds_verified',
    'payment_method_imported'
  )),
  actor_id UUID NOT NULL,
  actor_type VARCHAR(20) NOT NULL CHECK (actor_type IN ('user', 'system', 'api_key')),
  resource_id UUID NOT NULL,
  resource_type VARCHAR(20) NOT NULL DEFAULT 'payment_method' CHECK (resource_type IN ('payment_method')),
  details JSONB NOT NULL DEFAULT '{}',
  ip_address VARCHAR(45),
  user_agent VARCHAR(512),
  signature VARCHAR(255)
);

-- Indexes for payment_methods
CREATE INDEX IF NOT EXISTS idx_payment_methods_customer_id ON payment_methods(customer_id);
CREATE INDEX IF NOT EXISTS idx_payment_methods_fingerprint ON payment_methods(fingerprint);
CREATE INDEX IF NOT EXISTS idx_payment_methods_type_status ON payment_methods(type, status);
CREATE INDEX IF NOT EXISTS idx_payment_methods_token ON payment_methods(token);
CREATE INDEX IF NOT EXISTS idx_payment_methods_network_token ON payment_methods(network_token);

-- Indexes for payment_audit_logs
CREATE INDEX IF NOT EXISTS idx_payment_audit_logs_event_id ON payment_audit_logs(event_id);
CREATE INDEX IF NOT EXISTS idx_payment_audit_logs_resource_id ON payment_audit_logs(resource_id);
CREATE INDEX IF NOT EXISTS idx_payment_audit_logs_event_type ON payment_audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_payment_audit_logs_timestamp ON payment_audit_logs(timestamp);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER update_payment_methods_updated_at
  BEFORE UPDATE ON payment_methods
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_payment_audit_logs_timestamp
  BEFORE UPDATE ON payment_audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Policy for row-level security (if enabled)
-- ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE payment_audit_logs ENABLE ROW LEVEL SECURITY;

-- Add comments for documentation
COMMENT ON TABLE payment_methods IS 'PCI DSS SAQ A-EP compliant payment method vault';
COMMENT ON TABLE payment_audit_logs IS 'Immutable audit log for PCI DSS compliance';

COMMENT ON COLUMN payment_methods.token IS 'Vault token - PAN substitute (PCI compliant)';
COMMENT ON COLUMN payment_methods.fingerprint IS 'Unique identifier for the payment method (PCI compliant)';
COMMENT ON COLUMN payment_methods.metadata IS 'Additional metadata for the payment method';
COMMENT ON COLUMN payment_methods.network_token IS 'Network token (Visa/Mastercard) for card payments';
