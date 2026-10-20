import { createHash } from 'node:crypto';

export interface CourierWebhookSchemaStateInput {
  referenceId: string;
  dedupKeyCount: number;
  partitionCount: number;
  duplicateEventCount: number;
  thresholdLimit?: number;
}

export interface CourierWebhookSchemaState {
  referenceId: string;
  dedupKeyCount: number;
  partitionCount: number;
  duplicateEventCount: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function validateCourierIdempotencyMigration(input: CourierWebhookSchemaStateInput): CourierWebhookSchemaState {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('validateCourierIdempotencyMigration: referenceId is required');
  }
  if (
    !Number.isFinite(input.dedupKeyCount) ||
    !Number.isFinite(input.partitionCount) ||
    !Number.isFinite(input.duplicateEventCount)
  ) {
    throw new Error('validateCourierIdempotencyMigration: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.dedupKeyCount));
  const v2 = Math.max(0, Math.trunc(input.partitionCount));
  const v3 = Math.max(0, Math.trunc(input.duplicateEventCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (dedupKeyCount=${v1}, partitionCount=${v2}, duplicateEventCount=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, duplicateEventCount=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    dedupKeyCount: v1,
    partitionCount: v2,
    duplicateEventCount: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    dedupKeyCount: v1,
    partitionCount: v2,
    duplicateEventCount: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
