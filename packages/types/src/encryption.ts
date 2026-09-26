/**
 * #68 — Column-level encryption for PII data at rest.
 *
 * Data types specified in the issue, plus the operational shapes the
 * encryption/decryption pipeline (packages/utils/src/encryption) builds on.
 *
 * Encrypted values are stored in PostgreSQL as text columns; the ciphertext,
 * IV and GCM auth tag are base64. Every encrypted value carries its key
 * version and algorithm so decryption always uses the same key/derivation
 * that encrypted it — this is what makes zero-downtime key rotation possible
 * (old rows can keep pointing at the previous version until re-encrypted).
 */

export type EncryptionAlgorithm = "AES-256-GCM" | "AES-256-CBC";
export type EncryptionKeyProvider = "aws_kms" | "vault" | "local";

export interface EncryptionConfig {
  algorithm: EncryptionAlgorithm;
  keyProvider: EncryptionKeyProvider;
  keyId: string;
  keyRotationDays: number;
  contextField?: string;
}

export interface EncryptedField {
  /** base64 — the ciphertext. */
  ciphertext: string;
  /** base64 — initialisation vector. */
  iv: string;
  /** base64 — GCM authentication tag (omitted / empty for CBC). */
  authTag: string;
  /** Version of the key that encrypted this value (e.g. 1, 2, ...). */
  keyVersion: number;
  algorithm: EncryptionAlgorithm;
}

export interface KeyRotationStatus {
  keyId: string;
  currentVersion: number;
  previousVersion?: number;
  rotationInProgress: boolean;
  lastRotatedAt: string;
  nextRotationAt: string;
}

// ─── PII classification & registry ──────────────────────────────────────────

/** Sensitivity/regulator classification for a PII column. */
export type PiiClassification =
  /** Personally identifiable information under GDPR. */
  | "gdpr_pii"
  /** PCI DSS cardholder data (PAN, tokens, cryptograms). */
  | "pci_dss"
  /** Credentials/secrets (password hash, signing keys). */
  | "credential"
  /** Financial account data (bank account, routing number). */
  | "financial"
  /** Stellar wallet identifiers that can be linked to a natural person. */
  | "wallet_identifier";

/** Field-level access control grants for a single column (SOC2/GDPR). */
export type FieldAccessRole =
  | "admin"
  | "support"
  | "compliance"
  | "service"
  | "owner"
  | "system";

export interface PiiColumn {
  table: string;
  column: string;
  classification: PiiClassification;
  /**
   * True when the value needs to remain searchable/queryable (e.g.
   * email) and is therefore represented as a blind index/HMAC alongside
   * the encrypted value.
   */
  indexed: boolean;
  /** Roles allowed to decrypt this column. Empty = only the system. */
  decryptRoles: FieldAccessRole[];
  /** Human-readable GDPR Article 4(1) justification. */
  purpose: string;
}

export interface PiiAccessDecision {
  allowed: boolean;
  table: string;
  column: string;
  role: FieldAccessRole;
  reason: string;
}

// ─── Key access audit ───────────────────────────────────────────────────────

export type KeyAccessOperation = "encrypt" | "decrypt" | "unwrap" | "rotate";

export interface KeyAccessRecord {
  id: string;
  occurredAt: string;
  table: string;
  column: string;
  operation: KeyAccessOperation;
  keyId: string;
  keyVersion: number;
  actorRole: FieldAccessRole | null;
  /** Additional Authenticated Data / encryption context used for the call. */
  context: Record<string, string>;
  success: boolean;
  error?: string;
}