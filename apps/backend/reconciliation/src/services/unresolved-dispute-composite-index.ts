import { createHash } from 'node:crypto';

export interface DisputeCompositeIndexPlanInput {
  referenceId: string;
  unresolvedDisputeRows: number;
  indexSelectivityBps: number;
  seqScanFallbackCount: number;
  thresholdLimit?: number;
}

export interface DisputeCompositeIndexPlan {
  referenceId: string;
  unresolvedDisputeRows: number;
  indexSelectivityBps: number;
  seqScanFallbackCount: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function evaluateDisputeCompositeIndexScan(input: DisputeCompositeIndexPlanInput): DisputeCompositeIndexPlan {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('evaluateDisputeCompositeIndexScan: referenceId is required');
  }
  if (
    !Number.isFinite(input.unresolvedDisputeRows) ||
    !Number.isFinite(input.indexSelectivityBps) ||
    !Number.isFinite(input.seqScanFallbackCount)
  ) {
    throw new Error('evaluateDisputeCompositeIndexScan: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.unresolvedDisputeRows));
  const v2 = Math.max(0, Math.trunc(input.indexSelectivityBps));
  const v3 = Math.max(0, Math.trunc(input.seqScanFallbackCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (unresolvedDisputeRows=${v1}, indexSelectivityBps=${v2}, seqScanFallbackCount=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, seqScanFallbackCount=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    unresolvedDisputeRows: v1,
    indexSelectivityBps: v2,
    seqScanFallbackCount: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    unresolvedDisputeRows: v1,
    indexSelectivityBps: v2,
    seqScanFallbackCount: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
