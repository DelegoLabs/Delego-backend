/**
 * Session Key Delegation types.
 * Closes #282
 */

export interface SignWithSessionKeyDTO {
  sessionPublicKey: string;
  contractCallXdr: string;
  requestedAmountStroops: string;
}

export interface SessionKeyRecord {
  sessionPublicKey: string;
  userId: string;
  encryptedPrivateKey: string;
  vaultKeyPath: string;
  spendingLimitStroops: string;
  spentAmountStroops: string;
  expiresAt: number;
  createdAt: string;
  policy: SessionKeyPolicy;
}

export interface SessionKeyPolicy {
  allowedContracts: string[];
  allowedMethods: string[];
  maxPerCallStroops: string;
  maxTotalStroops: string;
  expiresInSeconds: number;
}

export interface SignResult {
  success: boolean;
  signedTxXdr?: string;
  signature?: string;
  remainingBudgetStroops?: string;
  error?: string;
}
