import { createHash } from 'node:crypto';

export interface MerkleMemoBatchInput {
  referenceId: string;
  leafCount: number;
  batchSeqNumber: number;
  unanchoredLagSecs: number;
  thresholdLimit?: number;
}

export interface MerkleMemoBatch {
  referenceId: string;
  leafCount: number;
  batchSeqNumber: number;
  unanchoredLagSecs: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function computeAuditBatchMerkleMemo(input: MerkleMemoBatchInput): MerkleMemoBatch {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('computeAuditBatchMerkleMemo: referenceId is required');
  }
  if (
    !Number.isFinite(input.leafCount) ||
    !Number.isFinite(input.batchSeqNumber) ||
    !Number.isFinite(input.unanchoredLagSecs)
  ) {
    throw new Error('computeAuditBatchMerkleMemo: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.leafCount));
  const v2 = Math.max(0, Math.trunc(input.batchSeqNumber));
  const v3 = Math.max(0, Math.trunc(input.unanchoredLagSecs));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (leafCount=${v1}, batchSeqNumber=${v2}, unanchoredLagSecs=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, unanchoredLagSecs=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    leafCount: v1,
    batchSeqNumber: v2,
    unanchoredLagSecs: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    leafCount: v1,
    batchSeqNumber: v2,
    unanchoredLagSecs: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
