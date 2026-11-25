# GDPR "Right to be Forgotten" Account Erasure

This document describes the GDPR-compliant account erasure implementation for the Delego platform.

## Overview

The GDPR "Right to be Forgotten" (Article 17) allows users to request complete erasure of their personal data while preserving on-chain transaction integrity. This implementation:

- Permanently removes PII from application databases
- Anonymizes payment records with cryptographic hashes
- Preserves on-chain transaction hashes for accounting/audit
- Generates cryptographic erasure certificates
- Maintains immutable audit logs

## API Endpoints

### 1. Create Erasure Request
**POST** `/api/v1/user/account/erasure-request`

Initiates the erasure process with two-factor/cryptographic signature confirmation.

**Request Body:**
```json
{
  "walletAddress": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "confirmationHash": "sha256_hash_of_confirmation_data",
  "confirmationMethod": "two_factor|cryptographic_signature"
}
```

**Response:**
```json
{
  "data": {
    "erasureRequest": {
      "id": "uuid",
      "userId": "uuid",
      "walletAddress": "G...",
      "status": "pending",
      "confirmationMethod": "two_factor",
      "createdAt": "2026-11-21T..."
    },
    "message": "Erasure request created. Confirmation pending."
  },
  "error": null
}
```

### 2. Confirm Erasure Request
**POST** `/api/v1/user/account/confirm-erasure`

Confirms erasure request with second factor (OTP, wallet signature, etc.).

**Request Body:**
```json
{
  "requestId": "uuid",
  "confirmationHash": "sha256_hash_of_confirmation_data"
}
```

**Response:**
```json
{
  "data": {
    "report": {
      "userId": "uuid",
      "walletAddress": "G...",
      "anonymizedPaymentRecords": 5,
      "purgedChatMessages": 0,
      "purgedPreferences": 3,
      "completedAt": "2026-11-21T..."
    },
    "certificate": {
      "userId": "uuid",
      "walletAddress": "G...",
      "certificateHash": "sha256_hash_of_certificate",
      "issuedAt": "2026-11-21T...",
      "issuer": "delego-platform"
    },
    "message": "Account successfully erased. Certificate generated."
  },
  "error": null
}
```

### 3. Direct Account Deletion
**DELETE** `/api/v1/user/account`

Direct account deletion with two-factor confirmation.

**Request Body:**
```json
{
  "walletAddress": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "confirmationHash": "sha256_hash_of_confirmation_data",
  "confirmationMethod": "two_factor|cryptographic_signature"
}
```

**Response:**
```json
{
  "data": {
    "message": "Account successfully erased.",
    "report": { ... erasure report ... },
    "certificate": { ... erasure certificate ... }
  },
  "error": null
}
```

### 4. Get Erasure Request Status
**GET** `/api/v1/user/account/erasure-status/:requestId`

### 5. Get Erasure Certificate
**GET** `/api/v1/user/account/erasure-certificate/:certificateHash`

## Database Tables

### account_erasure_requests
Stores erasure request metadata:
- `id` - Request UUID
- `user_id` - User being erased
- `wallet_address` - User's wallet address
- `confirmation_hash` - Cryptographic proof of confirmation
- `confirmation_method` - "two_factor" or "cryptographic_signature"
- `status` - "pending", "confirming", "processing", "completed", "failed"
- `anonymized_payment_records` - Count of anonymized payment records
- `purged_chat_messages` - Count of purged chat messages
- `purged_preferences` - Count of purged preferences
- `completed_at` - Timestamp when erasure completed
- `failed_at` - Timestamp if erasure failed
- `error_message` - Error details if failed

### erasure_certificates
Cryptographic proof of erasure:
- `certificate_hash` - SHA256 hash of certificate data
- `chain_integrity_hash` - Links to on-chain transaction
- `issuer` - "delego-platform"

### erasure_payment_hashes
Anonymized payment record metadata:
- `buyer_address_hash` - SHA256 hash of buyer address
- `seller_address_hash` - SHA256 hash of seller address

### erasure_chat_tombstones
Tombstone records for deleted chat messages

### erasure_preferences_tombstones
Tombstone records for deleted preferences

## Data Anonymization

### Payment Records
Personal buyer/seller addresses are replaced with SHA256 hashes while preserving:
- Transaction amounts
- Escrow contract IDs
- Transaction status
- Timestamps

### Chat Messages
Content is permanently deleted. Tombstone records track deletion.

### Preferences
All notification preferences are permanently deleted. Tombstone records track deletion.

## Erasure Certificate

The erasure certificate provides cryptographic proof of erasure for compliance audits:

```typescript
interface ErasureCertificate {
  userId: string;
  walletAddress: string;
  anonymizedPaymentRecords: number;
  purgedChatMessages: number;
  purgedPreferences: number;
  certificateHash: string; // SHA256 of certificate data
  chainIntegrityHash: string; // SHA256 of wallet address (on-chain link)
  issuer: string;
  issuedAt: string;
}
```

## Security Considerations

1. **Confirmation Requirements**: Two-factor or cryptographic signature required
2. **Immutable Audit Logs**: All erasure requests are logged
3. **Irreversible Operations**: Once executed, erasure cannot be undone
4. **On-Chain Preservation**: Transaction hashes remain on Stellar blockchain
5. **Access Control**: Users can only erase their own accounts

## Compliance

This implementation supports GDPR Article 17 (Right to be Forgotten) by:

- [x] Providing clear erasure request mechanism
- [x] Implementing timely deletion (immediate execution)
- [x] Preserving on-chain transaction integrity
- [x] Generating cryptographic proof of erasure
- [x] Maintaining immutable audit logs

## Testing

To test the erasure flow:

1. Create an erasure request with a valid wallet address
2. Confirm with the proper confirmation hash
3. Verify erasure certificate is generated
4. Check that PII has been anonymized
5. Confirm on-chain transaction data is preserved

## References

- [GDPR Article 17 - Right to erasure (Article 17)](https://gdpr-info.eu/art-17-gdpr/)
- [Stellar Transaction Hashes](https://developers.stellar.org/docs/data/rest-api/explorer/get-transactions/)
- [Sequelize ORM](https://sequelize.org/)