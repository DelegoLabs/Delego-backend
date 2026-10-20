import { createHash } from 'node:crypto';

export interface InventoryStreamResultInput {
  referenceId: string;
  availableUnits: number;
  requestedUnits: number;
  consumerLagCount: number;
  thresholdLimit?: number;
}

export interface InventoryStreamResult {
  referenceId: string;
  availableUnits: number;
  requestedUnits: number;
  consumerLagCount: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function processInventoryDecrementStream(input: InventoryStreamResultInput): InventoryStreamResult {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('processInventoryDecrementStream: referenceId is required');
  }
  if (
    !Number.isFinite(input.availableUnits) ||
    !Number.isFinite(input.requestedUnits) ||
    !Number.isFinite(input.consumerLagCount)
  ) {
    throw new Error('processInventoryDecrementStream: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.availableUnits));
  const v2 = Math.max(0, Math.trunc(input.requestedUnits));
  const v3 = Math.max(0, Math.trunc(input.consumerLagCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (availableUnits=${v1}, requestedUnits=${v2}, consumerLagCount=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, consumerLagCount=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    availableUnits: v1,
    requestedUnits: v2,
    consumerLagCount: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    availableUnits: v1,
    requestedUnits: v2,
    consumerLagCount: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
