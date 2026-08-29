/**
 * Account Recovery Types
 * Social recovery, emergency contacts, and hardware wallet recovery
 */

export type RecoveryType = "social" | "emergency" | "hardware";
export type RecoveryStatus = "pending" | "verifying" | "delayed" | "approved" | "completed" | "cancelled";
export type GuardianType = "email" | "phone" | "wallet" | "hardware";
export type RecoveryAction = 
  | "initiated"
  | "guardian_approved"
  | "guardian_rejected"
  | "delay_expired"
  | "completed"
  | "cancelled";

export interface RecoveryConfig {
  guardians: Array<{
    id: string;
    type: GuardianType;
    identifier: string;
    verified: boolean;
    weight: number;
    addedAt?: string;
    removedAt?: string;
  }>;
  threshold: number; // Minimum weight required for recovery approval
  delayHours: number; // Time delay before recovery can complete
  emergencyContacts: Array<{
    id: string;
    name: string;
    email: string;
    phone: string;
    verified: boolean;
    addedAt?: string;
    removedAt?: string;
  }>;
}

export interface RecoveryRequest {
  id: string;
  accountId: string;
  initiatedBy: string; // user or guardian ID
  type: RecoveryType;
  status: RecoveryStatus;
  guardiansApproved: string[];
  guardiansRejected: string[];
  delayEndsAt?: string; // When the time delay expires
  initiatedAt: string;
  expiresAt: string;
  completedAt?: string;
  cancelledAt?: string;
  newCredentials?: {
    publicKey: string;
    recoveryPhrase?: string;
    newStellarAddress?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface RecoveryAudit {
  requestId: string;
  action: RecoveryAction;
  actor: string; // user ID, guardian ID, or system
  timestamp: string;
  details: Record<string, unknown>;
}

export interface GuardianVerificationChallenge {
  method: "email" | "phone" | "wallet_signature" | "hardware_signature";
  challengeId: string;
  expiresAt: string;
  attempts: number;
  maxAttempts: number;
}

export interface RecoveryInitiationRequest {
  type: RecoveryType;
  guardianIds?: string[]; // For social recovery
  email?: string; // For emergency recovery
  phoneNumber?: string; // For emergency recovery
}

export interface GuardianApprovalRequest {
  verificationCode?: string;
  walletSignature?: string; // For wallet-based guardians
  hardwareSignature?: string; // For hardware wallet guardians
  metadata?: Record<string, unknown>;
}

export interface RecoveryChallengeRequest {
  method: "email" | "phone" | "wallet" | "hardware";
  identifier: string;
  challengeType: "verify_guardian" | "verify_emergency_contact" | "complete_recovery";
}

export interface RecoveryChallengeResponse {
  challengeId: string;
  method: "email" | "phone" | "wallet_signature" | "hardware_signature";
  expiresAt: string;
  attempts: number;
  maxAttempts: number;
}

export interface RecoveryCompleteRequest {
  verificationCode?: string;
  signature?: string; // New signature for the recovery
  newStellarAddress?: string;
}

export interface RecoveryListRequest {
  accountId: string;
  status?: RecoveryStatus;
  page?: number;
  limit?: number;
}

export interface RecoveryListResponse {
  recoveryRequests: RecoveryRequest[];
  totalCount: number;
  page: number;
  limit: number;
  totalPages: number;
}

// Guardian management
export interface AddGuardianRequest {
  type: GuardianType;
  identifier: string;
  weight: number;
  verifyAfterAdd?: boolean;
}

export interface RemoveGuardianRequest {
  guardianId: string;
  reason: string;
}

export interface UpdateGuardianRequest {
  guardianId: string;
  weight?: number;
  verified?: boolean;
}

export interface AddEmergencyContactRequest {
  name: string;
  email: string;
  phone: string;
}

export interface RemoveEmergencyContactRequest {
  contactId: string;
  reason: string;
}

// Recovery config management
export interface UpdateRecoveryConfigRequest {
  threshold?: number;
  delayHours?: number;
  guardians?: AddGuardianRequest | RemoveGuardianRequest | UpdateGuardianRequest[];
  emergencyContacts?: AddEmergencyContactRequest | RemoveEmergencyContactRequest;
}

export interface RecoveryConfigResponse {
  guardians: RecoveryConfig["guardians"];
  threshold: number;
  delayHours: number;
  emergencyContacts: RecoveryConfig["emergencyContacts"];
  currentProgress: {
    guardiansVerified: number;
    totalGuardians: number;
    weightVerified: number;
    weightThreshold: number;
  };
  nextRecoveryTime?: string;
}
