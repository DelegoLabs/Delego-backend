import { createHash } from 'node:crypto';

export interface EventDedupBatchResultInput {
  referenceId: string;
  incomingEventCount: number;
  duplicateHitCount: number;
  ttlSeconds: number;
  thresholdLimit?: number;
}

export interface EventDedupBatchResult {
  referenceId: string;
  incomingEventCount: number;
  duplicateHitCount: number;
  ttlSeconds: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function deduplicateSorobanEvents(input: EventDedupBatchResultInput): EventDedupBatchResult {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('deduplicateSorobanEvents: referenceId is required');
  }
  if (
    !Number.isFinite(input.incomingEventCount) ||
    !Number.isFinite(input.duplicateHitCount) ||
    !Number.isFinite(input.ttlSeconds)
  ) {
    throw new Error('deduplicateSorobanEvents: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.incomingEventCount));
  const v2 = Math.max(0, Math.trunc(input.duplicateHitCount));
  const v3 = Math.max(0, Math.trunc(input.ttlSeconds));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (incomingEventCount=${v1}, duplicateHitCount=${v2}, ttlSeconds=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, ttlSeconds=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    incomingEventCount: v1,
    duplicateHitCount: v2,
    ttlSeconds: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    incomingEventCount: v1,
    duplicateHitCount: v2,
    ttlSeconds: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
