-- Migration: 022_audit_log
-- Description: Append-only, tamper-evident audit log for data modifications
-- across all tables, with hash chaining and DB-level immutability (Issue #66).
--
-- Immutability strategy: a BEFORE UPDATE/DELETE trigger raises an
-- exception, so no application code path — however written, however
-- privileged its DB role — can UPDATE or DELETE a row here short of a
-- superuser dropping the trigger. This is the practical equivalent of
-- WORM (write-once-read-many) storage without depending on
-- filesystem/object-storage WORM features this environment doesn't have.
--
-- Tamper evidence: each row stores `entry_hash`, a SHA-256 of its own
-- content chained with the previous row's hash (`prev_hash`), so altering
-- or removing any historical row (e.g. via direct DB access bypassing the
-- trigger, or a restored-from-backup row swap) breaks the hash chain from
-- that point forward. `packages/utils/src/audit/hashChain.ts` walks the
-- chain and reports the first break, if any.
--
-- Chain ordering: `sequence_num` (BIGSERIAL) is the authoritative "what's
-- the previous entry" key for computing/verifying the chain — NOT
-- `occurred_at`. Two inserts can land in the same application-clock
-- millisecond (or even the same DB transaction), and `id` is a random
-- UUID with no ordering relationship to insertion order, so neither is
-- safe to break ties with. A sequence is: Postgres hands out values
-- atomically and monotonically per INSERT, so "previous row" is always
-- unambiguous regardless of timestamp collisions.

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_num BIGSERIAL,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
  user_id UUID,
  session_id TEXT,
  ip_address INET,
  user_agent TEXT,
  old_values JSONB,
  new_values JSONB,
  changed_fields TEXT[] NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  transaction_id TEXT NOT NULL,
  prev_hash CHAR(64),
  entry_hash CHAR(64) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_log_sequence_num ON audit_log(sequence_num);
CREATE INDEX IF NOT EXISTS idx_audit_log_table_record ON audit_log(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_occurred_at ON audit_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_operation ON audit_log(operation);

-- Enforce append-only at the database level: any UPDATE or DELETE against
-- audit_log fails, regardless of caller.
CREATE OR REPLACE FUNCTION audit_log_prevent_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted (id=%)', TG_OP, OLD.id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_no_update ON audit_log;
CREATE TRIGGER trg_audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_mutation();

DROP TRIGGER IF EXISTS trg_audit_log_no_delete ON audit_log;
CREATE TRIGGER trg_audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_mutation();

-- Retention policy configuration (Issue #66's RetentionPolicy type).
-- Enforcement (the actual archival/deletion job) is NOT implemented here —
-- see docs/deployment/audit-log-siem-retention.md. This table only stores
-- the *policy*, which the query API and any future archival job read from.
CREATE TABLE IF NOT EXISTS audit_retention_policies (
  table_name TEXT PRIMARY KEY,
  retention_days INTEGER NOT NULL,
  archive_after_days INTEGER,
  archive_storage TEXT CHECK (archive_storage IN ('s3', 'cold_storage')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Down migration (manual rollback)
-- DROP TABLE IF EXISTS audit_retention_policies;
-- DROP TRIGGER IF EXISTS trg_audit_log_no_delete ON audit_log;
-- DROP TRIGGER IF EXISTS trg_audit_log_no_update ON audit_log;
-- DROP FUNCTION IF EXISTS audit_log_prevent_mutation();
-- DROP INDEX IF EXISTS idx_audit_log_operation;
-- DROP INDEX IF EXISTS idx_audit_log_occurred_at;
-- DROP INDEX IF EXISTS idx_audit_log_user_id;
-- DROP INDEX IF EXISTS idx_audit_log_table_record;
-- DROP INDEX IF EXISTS idx_audit_log_sequence_num;
-- DROP TABLE IF EXISTS audit_log;
