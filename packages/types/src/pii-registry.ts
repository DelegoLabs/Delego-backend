/**
 * #68 — Registry of PII columns across the Delego PostgreSQL schema.
 *
 * This is the source of truth application-layer encryption is driven from:
 * each column listed here is encrypted at rest (see
 * packages/utils/src/encryption/columnEncryptor.ts) before it is written to
 * PostgreSQL, and only decrypted by callers whose role is listed in
 * `decryptRoles`.
 *
 * Columns already protected by purpose-built mechanisms (bcrypt password
 * hashes, the wallet seed vault of Issue #31, the PCI token vault of
 * migration 033) are classified here so the registry is complete, but their
 * existing mechanism takes precedence — re-encrypting them on top of their
 * current protection is unnecessary.
 *
 * JSONB columns (`policy`, `line_items`, `payload`, `metadata`,
 * `guardians`, `emergency_contacts`) are listed because the JSON payloads
 * they carry routinely embed personal data (names, addresses, contact
 * details). They are encrypted/document-scoped at the application layer
 * rather than re-structured — see docs/PII_CATALOG.md.
 *
 * Update this registry (and docs/PII_CATALOG.md) whenever the schema changes.
 */

import type { EncryptedField, FieldAccessRole, PiiColumn } from "./encryption.js";

export type { PiiClassification, PiiColumn } from "./encryption.js";

/** Human-readable summary consumed by dashboards/compliance reviews. */
export const PII_REGISTRY_SUMMARY = {
  version: 1,
  tables: 9,
  encryptedColumns: 21,
  indexedColumns: ["users.email", "users.stellar_address", "oauth_accounts.provider_user_id"],
  updatedAt: "2026-09-24",
} as const;

export interface DataEncryptionKeyVersion {
  /** Integer key version (matches EncryptedField.keyVersion). */
  version: number;
  keyId: string;
  keyProvider: "aws_kms" | "vault" | "local";
  /** Wrapped data-key blob (KMS envelope) or local key fingerprint. */
  wrappedKey: string;
  activatedAt: string;
  status: "active" | "previous" | "retired";
}

// ─── PII column registry ────────────────────────────────────────────────────

const OWNER_SUPPORT: FieldAccessRole[] = ["owner", "support", "compliance", "admin", "system"];
const SUPPORT_COMPLIANCE: FieldAccessRole[] = ["support", "compliance", "admin", "system"];
const ADMIN_ONLY: FieldAccessRole[] = ["admin", "compliance", "system"];
const SYSTEM_ONLY: FieldAccessRole[] = ["system"];

/**
 * Every column in the schema containing PII, with its classification and the
 * roles permitted to decrypt it. `indexed` marks columns that need blind
 * indexes (deterministic HMAC) to stay queryable, e.g. users.email.
 */
export const PII_REGISTRY: PiiColumn[] = [
  // users — core account PII (GDPR)
  { table: "users", column: "email", classification: "gdpr_pii", indexed: true, decryptRoles: OWNER_SUPPORT, purpose: "Account login identifier and primary contact" },
  { table: "users", column: "password_hash", classification: "credential", indexed: false, decryptRoles: SYSTEM_ONLY, purpose: "bcrypt hash — never reversible; see existing password hashing" },
  { table: "users", column: "display_name", classification: "gdpr_pii", indexed: false, decryptRoles: OWNER_SUPPORT, purpose: "Profile display name" },
  { table: "users", column: "stellar_address", classification: "wallet_identifier", indexed: true, decryptRoles: OWNER_SUPPORT, purpose: "Wallet address linked to account identity" },

  // wallets — signing material (credential) + address
  { table: "wallets", column: "public_key", classification: "wallet_identifier", indexed: false, decryptRoles: SUPPORT_COMPLIANCE, purpose: "Stellar public key" },
  { table: "wallets", column: "encrypted_private_key", classification: "credential", indexed: false, decryptRoles: SYSTEM_ONLY, purpose: "Encrypted seed — handled by wallet vault (Issue #31), not re-encrypted" },

  // delegations — policy JSON may embed merchant/agent PII
  { table: "delegations", column: "policy", classification: "gdpr_pii", indexed: false, decryptRoles: OWNER_SUPPORT, purpose: "Delegation policy JSON can contain personal preferences" },

  // orders — line items with delivery/recipient details
  { table: "orders", column: "line_items", classification: "gdpr_pii", indexed: false, decryptRoles: OWNER_SUPPORT, purpose: "Order line items contain delivery/recipient details" },

  // oauth_accounts — third-party OAuth identities
  { table: "oauth_accounts", column: "provider_user_id", classification: "gdpr_pii", indexed: true, decryptRoles: SUPPORT_COMPLIANCE, purpose: "Third-party OAuth subject identifier" },
  { table: "oauth_accounts", column: "email", classification: "gdpr_pii", indexed: false, decryptRoles: SUPPORT_COMPLIANCE, purpose: "OAuth-linked email address" },
  { table: "oauth_accounts", column: "display_name", classification: "gdpr_pii", indexed: false, decryptRoles: SUPPORT_COMPLIANCE, purpose: "OAuth profile display name" },
  { table: "oauth_accounts", column: "avatar_url", classification: "gdpr_pii", indexed: false, decryptRoles: SUPPORT_COMPLIANCE, purpose: "OAuth avatar URL can embed account identifiers" },

  // payment_methods — PCI DSS cardholder data
  { table: "payment_methods", column: "fingerprint", classification: "pci_dss", indexed: true, decryptRoles: ADMIN_ONLY, purpose: "Card fingerprint for dedup — PCI scope" },
  { table: "payment_methods", column: "network_token", classification: "pci_dss", indexed: false, decryptRoles: ADMIN_ONLY, purpose: "Network token — PCI scope" },
  { table: "payment_methods", column: "network_token_cryptogram", classification: "pci_dss", indexed: false, decryptRoles: ADMIN_ONLY, purpose: "Network token cryptogram — PCI scope" },
  { table: "payment_methods", column: "three_d_secure_cryptogram", classification: "pci_dss", indexed: false, decryptRoles: ADMIN_ONLY, purpose: "3DS cryptogram — PCI scope" },

  // subscriptions — billing addresses (Stellar)
  { table: "subscriptions", column: "buyer_address", classification: "wallet_identifier", indexed: false, decryptRoles: SUPPORT_COMPLIANCE, purpose: "Billing wallet address" },
  { table: "subscriptions", column: "seller_address", classification: "wallet_identifier", indexed: false, decryptRoles: SUPPORT_COMPLIANCE, purpose: "Recipient wallet address" },

  // recovery — guardians/emergency contacts contain emails & phones
  { table: "recovery_configs", column: "guardians", classification: "gdpr_pii", indexed: false, decryptRoles: SYSTEM_ONLY, purpose: "Guardian objects may embed contact channels" },
  { table: "recovery_configs", column: "emergency_contacts", classification: "gdpr_pii", indexed: false, decryptRoles: SYSTEM_ONLY, purpose: "Emergency contacts (email/phone) for account recovery" },

  // scheduled_notifications — template payloads carry recipient data
  { table: "scheduled_notifications", column: "payload", classification: "gdpr_pii", indexed: false, decryptRoles: SUPPORT_COMPLIANCE, purpose: "Notification template payload can embed recipient PII" },
];

/**
 * Lookup helper: returns the registry entry for a table.column, if the column
 * is a registered PII column.
 */
export function lookupPiiColumn(table: string, column: string): PiiColumn | undefined {
  return PII_REGISTRY.find((entry) => entry.table === table && entry.column === column);
}

/** Serialized form used when the encrypted value is stored in a table. */
export type { EncryptedField };