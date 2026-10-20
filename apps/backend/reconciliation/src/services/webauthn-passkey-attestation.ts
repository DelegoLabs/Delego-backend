import { createHash } from 'node:crypto';

export interface PasskeyAttestationVerdictInput {
  referenceId: string;
  challengeAgeSecs: number;
  signCountDelta: number;
  authenticatorAaguidValid: number;
  thresholdLimit?: number;
}

export interface PasskeyAttestationVerdict {
  referenceId: string;
  challengeAgeSecs: number;
  signCountDelta: number;
  authenticatorAaguidValid: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function verifyWebAuthnPasskeyAttestation(input: PasskeyAttestationVerdictInput): PasskeyAttestationVerdict {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('verifyWebAuthnPasskeyAttestation: referenceId is required');
  }
  if (
    !Number.isFinite(input.challengeAgeSecs) ||
    !Number.isFinite(input.signCountDelta) ||
    !Number.isFinite(input.authenticatorAaguidValid)
  ) {
    throw new Error('verifyWebAuthnPasskeyAttestation: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.challengeAgeSecs));
  const v2 = Math.max(0, Math.trunc(input.signCountDelta));
  const v3 = Math.max(0, Math.trunc(input.authenticatorAaguidValid));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (challengeAgeSecs=${v1}, signCountDelta=${v2}, authenticatorAaguidValid=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, authenticatorAaguidValid=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    challengeAgeSecs: v1,
    signCountDelta: v2,
    authenticatorAaguidValid: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    challengeAgeSecs: v1,
    signCountDelta: v2,
    authenticatorAaguidValid: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
