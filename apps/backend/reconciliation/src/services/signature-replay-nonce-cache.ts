import { createHash } from 'node:crypto';

export interface NonceReplayVerificationInput {
  referenceId: string;
  nonceTimestampSec: number;
  currentTimestampSec: number;
  alreadySeenFlag: number;
  thresholdLimit?: number;
}

export interface NonceReplayVerification {
  referenceId: string;
  nonceTimestampSec: number;
  currentTimestampSec: number;
  alreadySeenFlag: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function verifyAndRecordSignatureNonce(input: NonceReplayVerificationInput): NonceReplayVerification {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('verifyAndRecordSignatureNonce: referenceId is required');
  }
  if (
    !Number.isFinite(input.nonceTimestampSec) ||
    !Number.isFinite(input.currentTimestampSec) ||
    !Number.isFinite(input.alreadySeenFlag)
  ) {
    throw new Error('verifyAndRecordSignatureNonce: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.nonceTimestampSec));
  const v2 = Math.max(0, Math.trunc(input.currentTimestampSec));
  const v3 = Math.max(0, Math.trunc(input.alreadySeenFlag));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (nonceTimestampSec=${v1}, currentTimestampSec=${v2}, alreadySeenFlag=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, alreadySeenFlag=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    nonceTimestampSec: v1,
    currentTimestampSec: v2,
    alreadySeenFlag: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    nonceTimestampSec: v1,
    currentTimestampSec: v2,
    alreadySeenFlag: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
