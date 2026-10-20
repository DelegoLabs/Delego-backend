import { createHash } from 'node:crypto';

export interface DeepPiiMaskingReportInput {
  referenceId: string;
  preservedIdCount: number;
  maskedPiiFieldCount: number;
  traversalDepth: number;
  thresholdLimit?: number;
}

export interface DeepPiiMaskingReport {
  referenceId: string;
  preservedIdCount: number;
  maskedPiiFieldCount: number;
  traversalDepth: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function evaluateSelectiveDeepPiiMasking(input: DeepPiiMaskingReportInput): DeepPiiMaskingReport {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('evaluateSelectiveDeepPiiMasking: referenceId is required');
  }
  if (
    !Number.isFinite(input.preservedIdCount) ||
    !Number.isFinite(input.maskedPiiFieldCount) ||
    !Number.isFinite(input.traversalDepth)
  ) {
    throw new Error('evaluateSelectiveDeepPiiMasking: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.preservedIdCount));
  const v2 = Math.max(0, Math.trunc(input.maskedPiiFieldCount));
  const v3 = Math.max(0, Math.trunc(input.traversalDepth));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (preservedIdCount=${v1}, maskedPiiFieldCount=${v2}, traversalDepth=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, traversalDepth=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    preservedIdCount: v1,
    maskedPiiFieldCount: v2,
    traversalDepth: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    preservedIdCount: v1,
    maskedPiiFieldCount: v2,
    traversalDepth: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
