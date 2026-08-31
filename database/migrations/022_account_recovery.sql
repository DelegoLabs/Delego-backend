-- Migration: 022_account_recovery
-- Description: Social recovery with guardians and emergency contacts

-- Recovery configs table
CREATE TABLE IF NOT EXISTS recovery_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  threshold SMALLINT NOT NULL DEFAULT 3 CHECK (threshold >= 1),
  delay_hours SMALLINT NOT NULL DEFAULT 168 CHECK (delay_hours >= 1 AND delay_hours <= 720),
  guardians JSONB NOT NULL DEFAULT '[]',
  emergency_contacts JSONB NOT NULL DEFAULT '[]',
  last_updated TIMESTAMPTZ DEFAULT NOW()
);

-- Recovery requests table
CREATE TABLE IF NOT EXISTS recovery_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  initiated_by UUID NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('social', 'emergency', 'hardware')),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verifying', 'delayed', 'approved', 'completed', 'cancelled')),
  guardians_approved UUID[] NOT NULL DEFAULT '{}',
  guardians_rejected UUID[] NOT NULL DEFAULT '{}',
  delay_ends_at TIMESTAMPTZ,
  initiated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  new_credentials JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'
);

-- Recovery audit logs table
CREATE TABLE IF NOT EXISTS recovery_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL,
  action VARCHAR(50) NOT NULL CHECK (action IN ('initiated', 'guardian_approved', 'guardian_rejected', 'delay_expired', 'completed', 'cancelled')),
  actor UUID NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details JSONB NOT NULL DEFAULT '{}',
  ip_address VARCHAR(45),
  user_agent VARCHAR(512)
);

-- Recovery challenges table
CREATE TABLE IF NOT EXISTS recovery_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES recovery_requests(id) ON DELETE CASCADE ON UPDATE CASCADE,
  guardian_id UUID,
  contact_id UUID,
  method VARCHAR(50) NOT NULL CHECK (method IN ('email', 'phone', 'wallet_signature', 'hardware_signature')),
  challenge_id VARCHAR(64) NOT NULL UNIQUE,
  code_hash VARCHAR(128),
  expires_at TIMESTAMPTZ NOT NULL,
  attempts SMALLINT NOT NULL DEFAULT 0,
  max_attempts SMALLINT NOT NULL DEFAULT 3,
  verified_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- Indexes for recovery_configs
CREATE INDEX IF NOT EXISTS idx_recovery_configs_account_id ON recovery_configs(account_id);

-- Indexes for recovery_requests
CREATE INDEX IF NOT EXISTS idx_recovery_requests_account_id ON recovery_requests(account_id);
CREATE INDEX IF NOT EXISTS idx_recovery_requests_status ON recovery_requests(status);
CREATE INDEX IF NOT EXISTS idx_recovery_requests_initiated_at ON recovery_requests(initiated_at);
CREATE INDEX IF NOT EXISTS idx_recovery_requests_expires_at ON recovery_requests(expires_at);
CREATE INDEX IF NOT EXISTS idx_recovery_requests_delay_ends_at ON recovery_requests(delay_ends_at);

-- Indexes for recovery_audit_logs
CREATE INDEX IF NOT EXISTS idx_recovery_audit_logs_request_id ON recovery_audit_logs(request_id);
CREATE INDEX IF NOT EXISTS idx_recovery_audit_logs_action ON recovery_audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_recovery_audit_logs_timestamp ON recovery_audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_recovery_audit_logs_actor ON recovery_audit_logs(actor);

-- Indexes for recovery_challenges
CREATE INDEX IF NOT EXISTS idx_recovery_challenges_request_id ON recovery_challenges(request_id);
CREATE INDEX IF NOT EXISTS idx_recovery_challenges_challenge_id ON recovery_challenges(challenge_id);
CREATE INDEX IF NOT EXISTS idx_recovery_challenges_expires_at ON recovery_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_recovery_challenges_verified_at ON recovery_challenges(verified_at);

-- Function to update last_updated timestamp
CREATE OR REPLACE FUNCTION update_recovery_config_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_updated = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for recovery_configs
CREATE TRIGGER update_recovery_configs_updated_at
  BEFORE UPDATE ON recovery_configs
  FOR EACH ROW
  EXECUTE FUNCTION update_recovery_config_updated_at();

-- Add comments for documentation
COMMENT ON TABLE recovery_configs IS 'Account recovery configuration with guardians and emergency contacts';
COMMENT ON TABLE recovery_requests IS 'Individual recovery requests with guardian approval tracking';
COMMENT ON TABLE recovery_audit_logs IS 'Immutable audit log for recovery actions';
COMMENT ON TABLE recovery_challenges IS 'Verification challenges for recovery guardians and contacts';

COMMENT ON COLUMN recovery_configs.guardians IS 'Array of guardian objects with weight and verification status';
COMMENT ON COLUMN recovery_configs.emergency_contacts IS 'Array of emergency contact objects';
COMMENT ON COLUMN recovery_requests.new_credentials IS 'New credentials after successful recovery';
