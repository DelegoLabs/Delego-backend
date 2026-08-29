# Account Recovery

Social recovery with guardians and emergency contacts.

## Overview

The Account Recovery system provides multiple recovery mechanisms for wallet users:

- **Social Recovery**: 3-of-5 guardian-based recovery with configurable time delays
- **Emergency Contacts**: Quick recovery via pre-designated emergency contacts
- **Hardware Wallet Recovery**: Secure recovery using hardware wallet signatures
- **Time-Delayed Recovery**: Configurable delays (default 7 days) to prevent unauthorized recovery

## API Endpoints

### Configuration

#### GET `/api/v1/recovery/config`

Get the recovery configuration for the authenticated user.

**Response:**
```json
{
  "data": {
    "guardians": [
      {
        "id": "guardian-1",
        "type": "wallet",
        "identifier": "0x1234...",
        "verified": true,
        "weight": 2
      }
    ],
    "threshold": 3,
    "delayHours": 168,
    "emergencyContacts": []
  },
  "error": null
}
```

#### POST `/api/v1/recovery/config`

Create or update recovery configuration.

**Request Body:**
```json
{
  "guardians": [
    {
      "type": "wallet",
      "identifier": "0x1234...",
      "weight": 2,
      "verified": false
    }
  ],
  "threshold": 3,
  "delayHours": 168,
  "emergencyContacts": [
    {
      "name": "John Doe",
      "email": "john@example.com",
      "phone": "+1234567890"
    }
  ]
}
```

### Guardian Management

#### POST `/api/v1/recovery/guardians`

Add a new guardian.

#### DELETE `/api/v1/recovery/guardians/:guardianId`

Remove a guardian.

#### PATCH `/api/v1/recovery/guardians/:guardianId/verify`

Verify a guardian.

**Request Body:**
```json
{
  "verified": true
}
```

### Emergency Contacts

#### POST `/api/v1/recovery/emergency-contacts`

Add an emergency contact.

#### DELETE `/api/v1/recovery/emergency-contacts/:contactId`

Remove an emergency contact.

### Recovery Requests

#### POST `/api/v1/recovery/:accountId/initiate`

Initiate a recovery request.

**Request Body:**
```json
{
  "type": "social",
  "guardianIds": ["guardian-1", "guardian-2"]
}
```

**Response:**
```json
{
  "data": {
    "id": "recovery-123",
    "accountId": "user-123",
    "initiatedBy": "user-123",
    "type": "social",
    "status": "pending",
    "guardiansApproved": [],
    "guardiansRejected": [],
    "initiatedAt": "2024-01-01T00:00:00.000Z",
    "expiresAt": "2024-01-08T00:30:00.000Z"
  },
  "error": null
}
```

#### POST `/api/v1/recovery/:recoveryId/approve`

Approve a recovery request (guardians only).

**Request Body:**
```json
{
  "verificationCode": "123456"
}
```

#### POST `/api/v1/recovery/:recoveryId/reject`

Reject a recovery request.

**Request Body:**
```json
{
  "reason": "Suspicious activity detected"
}
```

#### POST `/api/v1/recovery/:recoveryId/cancel`

Cancel a recovery request.

**Request Body:**
```json
{
  "reason": "No longer need recovery"
}
```

#### POST `/api/v1/recovery/:recoveryId/complete`

Complete a recovery request (after delay expires).

**Request Body:**
```json
{
  "verificationCode": "123456",
  "newStellarAddress": "new-public-key"
}
```

### Utility Endpoints

#### GET `/api/v1/recovery/:accountId/requests`

List all recovery requests for an account.

**Query Parameters:**
- `status`: Filter by status
- `page`: Page number (default: 1)
- `limit`: Items per page (default: 20)

#### GET `/api/v1/recovery/:accountId/progress`

Get recovery progress (guardian verification status).

**Response:**
```json
{
  "data": {
    "guardians": [...],
    "threshold": 3,
    "delayHours": 168,
    "emergencyContacts": [],
    "currentProgress": {
      "guardiansVerified": 2,
      "totalGuardians": 5,
      "weightVerified": 4,
      "weightThreshold": 3
    }
  },
  "error": null
}
```

#### GET `/api/v1/recovery/:accountId/verifiable`

Check if the account is recoverable.

**Response:**
```json
{
  "data": {
    "recoverable": true
  },
  "error": null
}
```

## Data Models

### RecoveryConfig

```typescript
interface RecoveryConfig {
  guardians: Array<{
    id: string;
    type: "email" | "phone" | "wallet" | "hardware";
    identifier: string;
    verified: boolean;
    weight: number;
    addedAt?: string;
  }>;
  threshold: number;        // Minimum weight required
  delayHours: number;       // Time delay before completion (default: 168 = 7 days)
  emergencyContacts: Array<{
    id: string;
    name: string;
    email: string;
    phone: string;
    verified: boolean;
  }>;
}
```

### RecoveryRequest

```typescript
interface RecoveryRequest {
  id: string;
  accountId: string;
  initiatedBy: string;  // user or guardian ID
  type: "social" | "emergency" | "hardware";
  status: "pending" | "verifying" | "delayed" | "approved" | "completed" | "cancelled";
  guardiansApproved: string[];
  guardiansRejected: string[];
  delayEndsAt?: string; // When delay expires
  initiatedAt: string;
  expiresAt: string;    // When request expires
  completedAt?: string;
  cancelledAt?: string;
  newCredentials?: {
    publicKey: string;
    newStellarAddress?: string;
  };
  metadata: Record<string, unknown>;
}
```

### RecoveryAuditLog

```typescript
interface RecoveryAuditLog {
  requestId: string;
  action: "initiated" | "guardian_approved" | "guardian_rejected" | 
          "delay_expired" | "completed" | "cancelled";
  actor: string;  // user ID or guardian ID
  timestamp: string;
  details: Record<string, unknown>;
}
```

## Recovery Flow

### Social Recovery Flow

```
1. User initiates recovery
   └─> POST /api/v1/recovery/:accountId/initiate
   
2. System creates recovery request
   ├─> Creates RecoveryRequest record
   ├─> Creates verification challenges for guardians
   ├─> Notifies guardians (via email/phone)
   └─> Logs "initiated" audit event
   
3. Guardians approve/reject
   ├─> Each guardian receives verification challenge
   ├─> Guardian submits verification code or signature
   ├─> POST /api/v1/recovery/:recoveryId/approve
   └─> System logs "guardian_approved" audit event
   
4. Threshold met?
   ├─> YES → Status changes to "delayed"
   │   └─> Start time delay period
   └─> NO → Wait for more approvals
   
5. Delay expires?
   ├─> YES → Status changes to "approved"
   └─> NO → Continue waiting
   
6. User completes recovery
   ├─> POST /api/v1/recovery/:recoveryId/complete
   ├─> System generates new credentials
   └─> Logs "completed" audit event
```

### Emergency Recovery Flow

```
1. User initiates emergency recovery
   └─> POST /api/v1/recovery/:accountId/initiate
   
2. System creates recovery request
   ├─> Creates RecoveryRequest record
   ├─> Notifies emergency contacts
   └─> Logs "initiated" audit event
   
3. Emergency contact verifies
   ├─> Emergency contact submits verification
   ├─> POST /api/v1/recovery/:recoveryId/approve
   └─> System logs "guardian_approved" audit event
   
4. Recovery completes immediately
   ├─> No time delay for emergency recovery
   └─> Status changes to "delayed" → "approved"
```

## Time Delay Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `delayHours` | 168 (7 days) | Time before recovery can complete |
| `threshold` | 3 | Minimum guardian weight required |
| `maxAttempts` | 3 | Maximum verification attempts |

## Security Features

### 1. Guardian Verification
- Guardians must be verified before approval
- Verification methods: email, phone, wallet signature, hardware signature

### 2. Time Delay
- Configurable delay between approval and completion
- Prevents unauthorized rapid recovery
- Default: 7 days

### 3. Audit Trail
- Immutable audit logs for all actions
- Tracks who approved/rejected and when

### 4. Weighted Approval
- Guardians have configurable weights
- Recovery requires minimum total weight
- 3-of-5 with weights: 2,2,1,1,1 = threshold 3

### 5. Challenge System
- Each guardian receives a unique challenge
- Code or signature required for approval
- Maximum 3 attempts before challenge expires

## Recovery Scenarios

### Scenario 1: User loses device with verified guardians
1. User initiates social recovery
2. User contacts 3 guardians
3. Guardians verify and approve
4. Wait 7 days
5. User completes recovery with new credentials

### Scenario 2: Emergency recovery (immediate)
1. User initiates emergency recovery
2. Emergency contact verifies immediately
3. Recovery completes without delay

### Scenario 3: Guardian rejects recovery
1. User initiates recovery
2. One guardian rejects (adds to `guardiansRejected` array)
3. Recovery continues with remaining guardians
4. Threshold still met → proceed

### Scenario 4: Recovery cancelled
1. User or guardian cancels recovery
2. All verification challenges expire
3. New recovery can be initiated

## Environment Variables

```bash
# Recovery Configuration
RECOVERY_DEFAULT_DELAY_HOURS=168
RECOVERY_DEFAULT_THRESHOLD=3
RECOVERY_CHALLENGE_EXPIRY_HOURS=24
RECOVERY_CHALLENGE_MAX_ATTEMPTS=3

# Notification (for real implementation)
NOTIFICATION_SERVICE_URL=http://notification-service
EMAIL_SERVICE_URL=http://email-service
```

## Testing Recovery Scenarios

```typescript
// 1. Create recovery config with 3 guardians
await createRecoveryConfig(userId, {
  guardians: [
    { type: "wallet", identifier: "guardian-1", weight: 2, verified: true },
    { type: "wallet", identifier: "guardian-2", weight: 1, verified: true },
    { type: "wallet", identifier: "guardian-3", weight: 1, verified: true },
  ],
  threshold: 3,
  delayHours: 168,
});

// 2. Initiate recovery
const recovery = await initiateRecovery(userId, userId, {
  type: "social",
  guardianIds: ["guardian-1", "guardian-2", "guardian-3"],
});

// 3. Guardians approve
await processGuardianApproval(recovery.id, "guardian-1", {});
await processGuardianApproval(recovery.id, "guardian-2", {});
await processGuardianApproval(recovery.id, "guardian-3", {});

// 4. Wait for delay (or mock time)
await advanceTime(config.delayHours * 60 * 60 * 1000);

// 5. Complete recovery
await completeRecovery(recovery.id, userId, {
  newStellarAddress: "new-public-key",
});
```

## Migration

Run the migration:
```bash
pnpm db:migrate
```

Rollback:
```bash
pnpm db:migrate -- --direction down --target 22
```

## License

MIT
