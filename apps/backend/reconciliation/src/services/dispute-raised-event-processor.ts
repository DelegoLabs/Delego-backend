import { createHash } from 'node:crypto';

export interface DisputeEventProcessingResultInput {
  referenceId: string;
  escrowAmountStroops: number;
  evidenceCount: number;
  arbiterAssignedFlag: number;
  thresholdLimit?: number;
}

export interface DisputeEventProcessingResult {
  referenceId: string;
  escrowAmountStroops: number;
  evidenceCount: number;
  arbiterAssignedFlag: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function processDisputeRaisedOnChainEvent(input: DisputeEventProcessingResultInput): DisputeEventProcessingResult {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('processDisputeRaisedOnChainEvent: referenceId is required');
  }
  if (
    !Number.isFinite(input.escrowAmountStroops) ||
    !Number.isFinite(input.evidenceCount) ||
    !Number.isFinite(input.arbiterAssignedFlag)
  ) {
    throw new Error('processDisputeRaisedOnChainEvent: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.escrowAmountStroops));
  const v2 = Math.max(0, Math.trunc(input.evidenceCount));
  const v3 = Math.max(0, Math.trunc(input.arbiterAssignedFlag));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (escrowAmountStroops=${v1}, evidenceCount=${v2}, arbiterAssignedFlag=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, arbiterAssignedFlag=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    escrowAmountStroops: v1,
    evidenceCount: v2,
    arbiterAssignedFlag: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    escrowAmountStroops: v1,
    evidenceCount: v2,
    arbiterAssignedFlag: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
