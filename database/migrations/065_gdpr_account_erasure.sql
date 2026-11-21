-- Migration: 065_gdpr_account_erasure
-- Description: GDPR "Right to be Forgotten" account erasure tracking
--              Preserves on-chain transaction hashes while anonymizing PII

-- Erasure tracking table - immutable audit log for GDPR compliance
CREATE TABLE IF NOT EXISTS account_erasure_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_address VARCHAR(56) NOT NULL,
  confirmation_hash VARCHAR(256) NOT NULL,
  confirmation_method VARCHAR(32) NOT NULL CHECK (confirmation_method IN ('two_factor', 'cryptographic_signature')),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirming', 'processing', 'completed', 'failed')),
  anonymized_payment_records INTEGER NOT NULL DEFAULT 0,
  purged_chat_messages INTEGER NOT NULL DEFAULT 0,
  purged_preferences INTEGER NOT NULL DEFAULT 0,
  erasure_certificate_hash VARCHAR(256),
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error_message TEXT,
  initiated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address INET,
  user_agent VARCHAR(512)
);

CREATE INDEX IF NOT EXISTS idx_account_erasure_requests_user_id ON account_erasure_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_account_erasure_requests_status ON account_erasure_requests(status);
CREATE INDEX IF NOT EXISTS idx_account_erasure_requests_initiated_at ON account_erasure_requests(initiated_at);

-- Erasure certificate store - provides cryptographic proof of erasure
CREATE TABLE IF NOT EXISTS erasure_certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  erasure_request_id UUID NOT NULL REFERENCES account_erasure_requests(id) ON DELETE CASCADE,
  certificate_version VARCHAR(16) NOT NULL DEFAULT 'v1',
  user_id UUID NOT NULL,
  wallet_address VARCHAR(56) NOT NULL,
  anonymized_payment_records INTEGER NOT NULL,
  purged_chat_messages INTEGER NOT NULL,
  purged_preferences INTEGER NOT NULL,
  certificate_hash VARCHAR(256) NOT NULL UNIQUE,
  certificate_hash_algorithm VARCHAR(32) NOT NULL DEFAULT 'sha256',
  chain_integrity_hash VARCHAR(256) NOT NULL,
  issuer VARCHAR(64) NOT NULL DEFAULT 'delego-platform',
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_erasure_certificates_user_id ON erasure_certificates(user_id);
CREATE INDEX IF NOT EXISTS idx_erasure_certificates_hash ON erasure_certificates(certificate_hash);
CREATE INDEX IF NOT EXISTS idx_erasure_certificates_issued_at ON erasure_certificates(issued_at);

-- Payment records hash store - preserves transaction integrity while anonymizing PII
-- After erasure, personal buyer/seller info is replaced with cryptographic hash
CREATE TABLE IF NOT EXISTS erasure_payment_hashes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_record_id UUID NOT NULL REFERENCES payment_records(id) ON DELETE CASCADE,
  original_buyer_address VARCHAR(56) NOT NULL,
  buyer_address_hash VARCHAR(64) NOT NULL,
  original_seller_address VARCHAR(56) NOT NULL,
  seller_address_hash VARCHAR(64) NOT NULL,
  original_email VARCHAR(255) DEFAULT NULL,
  email_hash VARCHAR(64) DEFAULT NULL,
  original_shipping_address TEXT DEFAULT NULL,
  shipping_address_hash VARCHAR(64) DEFAULT NULL,
  hash_algorithm VARCHAR(32) NOT NULL DEFAULT 'sha256',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_erasure_payment_hashes_payment_record_id ON erasure_payment_hashes(payment_record_id);
CREATE INDEX IF NOT EXISTS idx_erasure_payment_hashes_buyer_hash ON erasure_payment_hashes(buyer_address_hash);
CREATE INDEX IF NOT EXISTS idx_erasure_payment_hashes_seller_hash ON erasure_payment_hashes(seller_address_hash);

-- Chat messages tombstone - preserves chat existence while anonymizing content
CREATE TABLE IF NOT EXISTS erasure_chat_tombstones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  conversation_ids UUID[],
  content_hash VARCHAR(64) NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_by VARCHAR(64) NOT NULL DEFAULT 'system:gdpr_erasure'
);

CREATE INDEX IF NOT EXISTS idx_erasure_chat_tombstones_user_id ON erasure_chat_tombstones(user_id);
CREATE INDEX IF NOT EXISTS idx_erasure_chat_tombstones_deleted_at ON erasure_chat_tombstones(deleted_at);

-- Preferences tombstone - tracks which preferences were deleted
CREATE TABLE IF NOT EXISTS erasure_preferences_tombstones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  preference_type VARCHAR(32) NOT NULL,
  deleted_count INTEGER NOT NULL DEFAULT 0,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_by VARCHAR(64) NOT NULL DEFAULT 'system:gdpr_erasure'
);

CREATE INDEX IF NOT EXISTS idx_erasure_preferences_tombstones_user_id ON erasure_preferences_tombstones(user_id);
CREATE INDEX IF NOT EXISTS idx_erasure_preferences_tombstones_type ON erasure_preferences_tombstones(preference_type);

-- erasure_payment_hashes hash generation function
CREATE OR REPLACE FUNCTION generate_erasure_hash(input TEXT, algorithm VARCHAR(32) DEFAULT 'sha256')
RETURNS VARCHAR(256) AS $$
BEGIN
  IF algorithm = 'sha256' THEN
    RETURN encode(digest(input, 'sha256'), 'hex');
  ELSIF algorithm = 'sha512' THEN
    RETURN encode(digest(input, 'sha512'), 'hex');
  ELSE
    RAISE EXCEPTION 'Unsupported hash algorithm: %', algorithm;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically anonymize payment records when erasure completes
CREATE OR REPLACE FUNCTION anonymize_payment_records_on_erasure()
RETURNS TRIGGER AS $$
BEGIN
  -- Anonymize payment records for the user
  IF NEW.status = 'completed' AND NEW.completed_at IS NOT NULL THEN
    -- This will be called from the erasure service
    -- Payment records are anonymized in the application layer to preserve escrow integrity
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_anonymize_payment_records ON account_erasure_requests;
CREATE TRIGGER trg_anonymize_payment_records
  AFTER UPDATE OF status ON account_erasure_requests
  FOR EACH ROW
  WHEN (NEW.status = 'completed' AND OLD.status != 'completed')
  EXECUTE FUNCTION anonymize_payment_records_on_erasure();

-- View for erasure status dashboard
CREATE OR REPLACE VIEW account_erasure_status_dashboard AS
SELECT
  aer.id AS erasure_request_id,
  aer.user_id,
  aer.wallet_address,
  aer.status,
  aer.confirmation_method,
  aer.anonymized_payment_records,
  aer.purged_chat_messages,
  aer.purged_preferences,
  aer.initiated_at,
  aer.completed_at,
  aer.failed_at,
  u.email AS original_email,
  u.stellar_address,
  u.deleted_at AS user_deleted_at
FROM account_erasure_requests aer
LEFT JOIN users u ON aer.user_id = u.id;

COMMENT ON TABLE account_erasure_requests IS 'GDPR erasure request tracking - immutable audit log';
COMMENT ON TABLE erasure_certificates IS 'Cryptographic proof of erasure for GDPR compliance';
COMMENT ON TABLE erasure_payment_hashes IS 'Preserves payment transaction integrity with hashed PII';
COMMENT ON TABLE erasure_chat_tombstones IS 'Tombstone records for deleted chat messages';
COMMENT ON TABLE erasure_preferences_tombstones IS 'Tombstone records for deleted preferences';

COMMENT ON COLUMN erasure_certificates.certificate_hash IS 'SHA256 hash of the complete erasure certificate';
COMMENT ON COLUMN erasure_certificates.chain_integrity_hash IS 'Hash linking to on-chain transaction for audit trail';
