import { createHash } from 'node:crypto';

export interface RedlockAcquisitionResultInput {
  referenceId: string;
  quorumNodesAcquired: number;
  totalRedisNodes: number;
  lockDriftMs: number;
  thresholdLimit?: number;
}

export interface RedlockAcquisitionResult {
  referenceId: string;
  quorumNodesAcquired: number;
  totalRedisNodes: number;
  lockDriftMs: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function evaluateCartCheckoutRedlock(input: RedlockAcquisitionResultInput): RedlockAcquisitionResult {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('evaluateCartCheckoutRedlock: referenceId is required');
  }
  if (
    !Number.isFinite(input.quorumNodesAcquired) ||
    !Number.isFinite(input.totalRedisNodes) ||
    !Number.isFinite(input.lockDriftMs)
  ) {
    throw new Error('evaluateCartCheckoutRedlock: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.quorumNodesAcquired));
  const v2 = Math.max(0, Math.trunc(input.totalRedisNodes));
  const v3 = Math.max(0, Math.trunc(input.lockDriftMs));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (quorumNodesAcquired=${v1}, totalRedisNodes=${v2}, lockDriftMs=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, lockDriftMs=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    quorumNodesAcquired: v1,
    totalRedisNodes: v2,
    lockDriftMs: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    quorumNodesAcquired: v1,
    totalRedisNodes: v2,
    lockDriftMs: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
