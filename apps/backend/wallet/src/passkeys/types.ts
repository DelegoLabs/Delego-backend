/**
 * Passkey / WebAuthn types.
 * Closes #281
 */

export interface WebAuthnVerificationPayload {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  challenge: string;
}

export interface PasskeyAccountMapping {
  userId: string;
  stellarAddress: string;
  credentialId: string;
  publicKeyDer: string;
}

export interface ChallengeResult {
  challenge: string;
  expiresAt: number;
}

export interface VerificationResult {
  verified: boolean;
  userId?: string;
  stellarAddress?: string;
  credentialId?: string;
  error?: string;
}
