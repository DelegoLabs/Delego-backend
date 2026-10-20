import { createHash } from 'node:crypto';

export interface SubnetVelocityVerdictInput {
  referenceId: string;
  requestsInWindow: number;
  uniqueWalletsInSubnet: number;
  failedPaymentCount: number;
  thresholdLimit?: number;
}

export interface SubnetVelocityVerdict {
  referenceId: string;
  requestsInWindow: number;
  uniqueWalletsInSubnet: number;
  failedPaymentCount: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function evaluateSubnetCheckoutVelocity(input: SubnetVelocityVerdictInput): SubnetVelocityVerdict {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('evaluateSubnetCheckoutVelocity: referenceId is required');
  }
  if (
    !Number.isFinite(input.requestsInWindow) ||
    !Number.isFinite(input.uniqueWalletsInSubnet) ||
    !Number.isFinite(input.failedPaymentCount)
  ) {
    throw new Error('evaluateSubnetCheckoutVelocity: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.requestsInWindow));
  const v2 = Math.max(0, Math.trunc(input.uniqueWalletsInSubnet));
  const v3 = Math.max(0, Math.trunc(input.failedPaymentCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (requestsInWindow=${v1}, uniqueWalletsInSubnet=${v2}, failedPaymentCount=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, failedPaymentCount=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    requestsInWindow: v1,
    uniqueWalletsInSubnet: v2,
    failedPaymentCount: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    requestsInWindow: v1,
    uniqueWalletsInSubnet: v2,
    failedPaymentCount: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
