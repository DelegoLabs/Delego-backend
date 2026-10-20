import { createHash } from 'node:crypto';

export interface DomainAcmeSyncStatusInput {
  referenceId: string;
  cnameVerifiedFlag: number;
  certExpiryDays: number;
  renewalAttemptCount: number;
  thresholdLimit?: number;
}

export interface DomainAcmeSyncStatus {
  referenceId: string;
  cnameVerifiedFlag: number;
  certExpiryDays: number;
  renewalAttemptCount: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function evaluateMerchantCnameAcmeSync(input: DomainAcmeSyncStatusInput): DomainAcmeSyncStatus {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('evaluateMerchantCnameAcmeSync: referenceId is required');
  }
  if (
    !Number.isFinite(input.cnameVerifiedFlag) ||
    !Number.isFinite(input.certExpiryDays) ||
    !Number.isFinite(input.renewalAttemptCount)
  ) {
    throw new Error('evaluateMerchantCnameAcmeSync: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.cnameVerifiedFlag));
  const v2 = Math.max(0, Math.trunc(input.certExpiryDays));
  const v3 = Math.max(0, Math.trunc(input.renewalAttemptCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (cnameVerifiedFlag=${v1}, certExpiryDays=${v2}, renewalAttemptCount=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, renewalAttemptCount=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    cnameVerifiedFlag: v1,
    certExpiryDays: v2,
    renewalAttemptCount: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    cnameVerifiedFlag: v1,
    certExpiryDays: v2,
    renewalAttemptCount: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
