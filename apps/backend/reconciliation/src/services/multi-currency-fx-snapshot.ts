import { createHash } from 'node:crypto';

export interface FxRateSnapshotRecordInput {
  referenceId: string;
  rateScaled: number;
  ageSeconds: number;
  maxSpreadBps: number;
  thresholdLimit?: number;
}

export interface FxRateSnapshotRecord {
  referenceId: string;
  rateScaled: number;
  ageSeconds: number;
  maxSpreadBps: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function evaluateFxSnapshotStaleness(input: FxRateSnapshotRecordInput): FxRateSnapshotRecord {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('evaluateFxSnapshotStaleness: referenceId is required');
  }
  if (
    !Number.isFinite(input.rateScaled) ||
    !Number.isFinite(input.ageSeconds) ||
    !Number.isFinite(input.maxSpreadBps)
  ) {
    throw new Error('evaluateFxSnapshotStaleness: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.rateScaled));
  const v2 = Math.max(0, Math.trunc(input.ageSeconds));
  const v3 = Math.max(0, Math.trunc(input.maxSpreadBps));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (rateScaled=${v1}, ageSeconds=${v2}, maxSpreadBps=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, maxSpreadBps=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    rateScaled: v1,
    ageSeconds: v2,
    maxSpreadBps: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    rateScaled: v1,
    ageSeconds: v2,
    maxSpreadBps: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
