# Payment Method Vault

PCI DSS SAQ A-EP Compliant Payment Method Tokenization Service

## Overview

The Payment Method Vault provides secure storage and tokenization of customer payment methods. It supports:

- **Card Tokenization**: Store and manage credit/debit cards with network tokenization
- **Bank Account Tokenization**: Securely store bank account information
- **Wallet Tokenization**: Support Apple Pay, Google Pay, PayPal, and Stellar wallets
- **3D Secure Authentication**: Integrated 3DS2 for enhanced security
- **Network Tokenization**: Visa Token Service (VTS) and Mastercard Credit Services (MCS)

## PCI DSS Compliance

This service is designed for **SAQ A-EP** compliance:

- Cardholder data is never stored in plaintext
- All PANs are tokenized using vault tokens
- Network tokenization supported for card networks
- Immutable audit logging for all operations
- HMAC-based integrity verification for audit logs

## API Endpoints

### Create Payment Methods

#### POST `/api/v1/payment-methods/card`

Create a card payment method.

**Request Body:**
```json
{
  "customerId": "user-uuid",
  "type": "card",
  "details": {
    "number": "4111111111111111",
    "expMonth": 12,
    "expYear": 2025,
    "cvc": "123"
  },
  "verification": {
    "method": "3ds",
    "returnUrl": "https://your-app.com/return"
  },
  "metadata": {},
  "threeDSecure": {
    "enabled": true
  }
}
```

**Response:**
```json
{
  "data": {
    "paymentMethodId": "pm_abc123",
    "token": "pm_xyz789",
    "fingerprint": "fp_abc123",
    "last4": "1111",
    "expiryMonth": 12,
    "expiryYear": 2025,
    "brand": "visa",
    "verified": false,
    "verificationRequired": true
  },
  "error": null
}
```

#### POST `/api/v1/payment-methods/bank-account`

Create a bank account payment method.

**Request Body:**
```json
{
  "customerId": "user-uuid",
  "type": "bank_account",
  "details": {
    "accountNumber": "1234567890",
    "routingNumber": "021000021",
    "accountType": "checking"
  },
  "verification": {
    "method": "microdeposit",
    "returnUrl": "https://your-app.com/return"
  }
}
```

#### POST `/api/v1/payment-methods/wallet`

Create a wallet payment method.

**Request Body:**
```json
{
  "customerId": "user-uuid",
  "type": "wallet",
  "details": {
    "walletType": "apple_pay",
    "walletToken": "wallet-token-here"
  }
}
```

### List Payment Methods

#### GET `/api/v1/payment-methods`

List all payment methods for a customer.

**Query Parameters:**
- `customerId` (required): Customer ID
- `status` (optional): Filter by status (active, expired, removed)
- `type` (optional): Filter by type (card, bank_account, wallet)
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 20)

### Verify Payment Method

#### POST `/api/v1/payment-methods/:id/verify`

Verify a payment method.

**Request Body:**
```json
{
  "method": "microdeposit",
  "amount1": 0,
  "amount2": 0
}
```

**Response:**
```json
{
  "data": {
    "paymentMethodId": "pm_abc123",
    "status": "verified",
    "verificationDetails": {
      "method": "microdeposit",
      "amount1": 0,
      "amount2": 0,
      "completedAt": "2024-01-01T00:00:00.000Z"
    }
  },
  "error": null
}
```

### Get Payment Method

#### GET `/api/v1/payment-methods/:id`

Get a specific payment method by ID.

### Update Payment Method

#### PATCH `/api/v1/payment-methods/:id`

Update a payment method's metadata or status.

**Request Body:**
```json
{
  "metadata": {},
  "status": "active",
  "threeDSecure": {
    "enabled": true
  }
}
```

### Remove Payment Method

#### DELETE `/api/v1/payment-methods/:id`

Remove (soft delete) a payment method.

**Request Body:**
```json
{
  "reason": "customer_request"
}
```

### Check Payment Method Usability

#### GET `/api/v1/payment-methods/:id/usable`

Check if a payment method is usable (active and not expired).

## Data Model

### PaymentMethod

```typescript
interface PaymentMethod {
  id: string;
  customerId: string;
  type: "card" | "bank_account" | "wallet" | "stellar_account";
  token: string; // Vault token (PAN substitute)
  brand?: string; // visa, mastercard, etc.
  last4?: string;
  expiryMonth?: number;
  expiryYear?: number;
  fingerprint: string; // Unique identifier
  networkToken?: {
    token: string;
    type: "visanet" | "mastercard-cvs" | "amex-epn" | "discover-dps";
    expiryMonth?: number;
    expiryYear?: number;
    cryptogram?: string;
  };
  verified: boolean;
  verificationMethod: "none" | "3ds" | "microdeposit" | "instant";
  metadata: Record<string, unknown>;
  status: "active" | "expired" | "removed";
  threeDSecure?: {
    enabled: boolean;
    challenged: boolean;
    version?: string;
    cryptogram?: string;
    eciFlag?: string;
  };
  createdAt: string;
  lastUsedAt?: string;
  removedAt?: string;
}
```

### AuditLog

```typescript
interface AuditLogEntry {
  id: string;
  eventId: string;
  timestamp: string;
  eventType: 
    | "payment_method_created"
    | "payment_method_updated"
    | "payment_method_verified"
    | "payment_method_removed"
    | "payment_method_tokenized"
    | "payment_method_network_tokenized"
    | "payment_method_3ds_verified"
    | "payment_method_imported";
  actorId: string;
  actorType: "user" | "system" | "api_key";
  resourceId: string;
  resourceType: "payment_method";
  details: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  signature?: string;
}
```

## Security Features

### 1. Tokenization

- Raw card numbers are never stored
- Each payment method has a unique vault token
- Token format: `pm_<uuid>`

### 2. Fingerprinting

- Each payment method has a unique fingerprint for identification
- Fingerprint format: `fp_<hash>_<timestamp>`

### 3. Network Tokenization

- Visa Token Service (VTS)
- Mastercard Credit Services (MCS)
- Amex Express Checkout Network (EPN)
- Discover Payment Services (DPS)

### 4. 3D Secure

- 3DS2 protocol support
- Challenge and frictionless flows
- ECI flag and cryptogram storage

### 5. Audit Logging

- Immutable audit logs for all operations
- Digital signature verification
- IP address and user agent tracking

## Verification Methods

### 3D Secure
- Used for card verification
- Requires customer interaction
- Supports both challenge and frictionless flows

### Microdeposit
- Used for bank account verification
- Two small deposits sent to the account
- Customer enters the deposit amounts

### Instant
- Used for wallet verification
- Immediate verification through wallet provider

## Lifecycle Management

### Status Transitions

```
active → expired (when card expires)
active → removed (soft delete)
removed → active (restore)
```

### Expiration Checking

Payment methods are checked for expiration on:
- Each use attempt
- When listing payment methods
- When checking usability

## Environment Variables

```bash
# Payment Method Vault Configuration
PAYMENT_VAULT_ENABLED=true
PAYMENT_VAULT_NETWORK_TOKENIZATION=true
PAYMENT_VAULT_3D_SECURE=true
PAYMENT_VAULT_VERIFICATION_ENABLED=true

# Audit Logging
PAYMENT_VAULT_AUDIT_LOGGING=true
PAYMENT_VAULT_AUDIT_LOG_SIGNATURE_ENABLED=true
```

## Usage Example

```typescript
import { createPaymentMethod } from "@delegolabs/gateway";

// Create a card payment method
const paymentMethod = await createPaymentMethod({
  customerId: "user-123",
  type: "card",
  details: {
    number: "4111111111111111",
    expMonth: 12,
    expYear: 2025,
    cvc: "123"
  },
  threeDSecure: {
    enabled: true
  }
});

// Verify the payment method
await verifyPaymentMethod(paymentMethod.paymentMethodId, {
  method: "3ds",
  returnUrl: "https://your-app.com/return"
});

// List all payment methods
const methods = await listPaymentMethods({
  customerId: "user-123",
  limit: 20
});
```

## Testing

Run tests with:
```bash
pnpm test --filter @delegolabs/gateway
```

## License

MIT
