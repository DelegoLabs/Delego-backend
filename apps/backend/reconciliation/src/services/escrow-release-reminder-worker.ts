import { createHash } from 'node:crypto';

export interface EscrowReminderDispatchInput {
  referenceId: string;
  pendingReleaseCount: number;
  hoursSinceDelivery: number;
  maxRemindersSent: number;
  thresholdLimit?: number;
}

export interface EscrowReminderDispatch {
  referenceId: string;
  pendingReleaseCount: number;
  hoursSinceDelivery: number;
  maxRemindersSent: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function planEscrowReleaseReminderBatch(input: EscrowReminderDispatchInput): EscrowReminderDispatch {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('planEscrowReleaseReminderBatch: referenceId is required');
  }
  if (
    !Number.isFinite(input.pendingReleaseCount) ||
    !Number.isFinite(input.hoursSinceDelivery) ||
    !Number.isFinite(input.maxRemindersSent)
  ) {
    throw new Error('planEscrowReleaseReminderBatch: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.pendingReleaseCount));
  const v2 = Math.max(0, Math.trunc(input.hoursSinceDelivery));
  const v3 = Math.max(0, Math.trunc(input.maxRemindersSent));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (pendingReleaseCount=${v1}, hoursSinceDelivery=${v2}, maxRemindersSent=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, maxRemindersSent=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    pendingReleaseCount: v1,
    hoursSinceDelivery: v2,
    maxRemindersSent: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    pendingReleaseCount: v1,
    hoursSinceDelivery: v2,
    maxRemindersSent: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
