# PII Data Catalog (at-rest encryption)

Source of truth: `packages/types/src/pii-registry.ts` (Issue #68). Every column
registered there is encrypted at rest by `packages/utils/src/encryption/`
before it is written to PostgreSQL. This catalog is a human-readable mirror for
reviewers, auditors, and on-call.

Notes:
- `indexed` columns get a **blind index** (deterministic HMAC-SHA256 of the
  value) so equality lookups still work against ciphertext.
- Columns already protected by purpose-built mechanisms (bcrypt password
  hashes, the wallet seed vault of Issue #31, the PCI token vault of migration
  033) are listed for completeness and are **not** re-encrypted.
- `decryptRoles`: the ONLY roles permitted to decrypt the field. `system` =
  server-side, no end-user identity.

## Registry (21 columns across 9 tables)

### users

| Column | Classification | Indexed | Decrypt roles |
|--------|----------------|---------|---------------|
| email | gdpr_pii | ✓ | owner, support, compliance, admin, system |
| password_hash | credential | – | system (bcrypt — never reversible) |
| display_name | gdpr_pii | – | owner, support, compliance, admin, system |
| stellar_address | wallet_identifier | ✓ | owner, support, compliance, admin, system |

### wallets

| Column | Classification | Indexed | Decrypt roles |
|--------|----------------|---------|---------------|
| public_key | wallet_identifier | – | support, compliance, admin, system |
| encrypted_private_key | credential | – | system (vault of Issue #31 handles seeds) |

### delegations

| Column | Classification | Indexed | Decrypt roles |
|--------|----------------|---------|---------------|
| policy | gdpr_pii | – | owner, support, compliance, admin, system |

### orders

| Column | Classification | Indexed | Decrypt roles |
|--------|----------------|---------|---------------|
| line_items | gdpr_pii | – | owner, support, compliance, admin, system |

### oauth_accounts

| Column | Classification | Indexed | Decrypt roles |
|--------|----------------|---------|---------------|
| provider_user_id | gdpr_pii | ✓ | support, compliance, admin, system |
| email | gdpr_pii | – | support, compliance, admin, system |
| display_name | gdpr_pii | – | support, compliance, admin, system |
| avatar_url | gdpr_pii | – | support, compliance, admin, system |

### payment_methods

| Column | Classification | Indexed | Decrypt roles |
|--------|----------------|---------|---------------|
| fingerprint | pci_dss | ✓ | admin, compliance, system |
| network_token | pci_dss | – | admin, compliance, system |
| network_token_cryptogram | pci_dss | – | admin, compliance, system |
| three_d_secure_cryptogram | pci_dss | – | admin, compliance, system |

### subscriptions

| Column | Classification | Indexed | Decrypt roles |
|--------|----------------|---------|---------------|
| buyer_address | wallet_identifier | – | support, compliance, admin, system |
| seller_address | wallet_identifier | – | support, compliance, admin, system |

### recovery_configs

| Column | Classification | Indexed | Decrypt roles |
|--------|----------------|---------|---------------|
| guardians | gdpr_pii | – | system |
| emergency_contacts | gdpr_pii | – | system |

### scheduled_notifications

| Column | Classification | Indexed | Decrypt roles |
|--------|----------------|---------|---------------|
| payload | gdpr_pii | – | support, compliance, admin, system |

## Accessibility groups

| Group | Roles |
|-------|-------|
| OWNER_SUPPORT | owner, support, compliance, admin, system |
| SUPPORT_COMPLIANCE | support, compliance, admin, system |
| ADMIN_ONLY | admin, compliance, system |
| SYSTEM_ONLY | system |

## Role meanings

| Role | Meaning |
|------|---------|
| owner | The data subject or their acting principal |
| support | Customer support agent (scoped, record-level) |
| compliance | Compliance / KYC reviewer |
| admin | Service admin |
| system | Server-side, no end-user identity |

## Counts

- **9** tables, **21** encrypted columns (asserted by `PII_REGISTRY_SUMMARY`)
- **3** blind-indexed columns: `users.email`, `users.stellar_address`,
  `oauth_accounts.provider_user_id`

## JSONB columns

`policy` (delegations), `line_items` (orders), `payload`
(scheduled_notifications), `guardians` + `emergency_contacts`
(recovery_configs) are JSONB documents that routinely embed personal data.
They are encrypted/document-scoped at the application layer rather than
re-structured. Registration lives in the registry above.

> Keep this catalog in sync with `PII_REGISTRY` whenever the schema changes.