import { createHash } from 'node:crypto';

export interface MultiMerchantCartSchemaReportInput {
  referenceId: string;
  subCartCount: number;
  foreignKeyCount: number;
  orphanedItemCount: number;
  thresholdLimit?: number;
}

export interface MultiMerchantCartSchemaReport {
  referenceId: string;
  subCartCount: number;
  foreignKeyCount: number;
  orphanedItemCount: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function validateMultiMerchantCartMigration(input: MultiMerchantCartSchemaReportInput): MultiMerchantCartSchemaReport {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('validateMultiMerchantCartMigration: referenceId is required');
  }
  if (
    !Number.isFinite(input.subCartCount) ||
    !Number.isFinite(input.foreignKeyCount) ||
    !Number.isFinite(input.orphanedItemCount)
  ) {
    throw new Error('validateMultiMerchantCartMigration: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.subCartCount));
  const v2 = Math.max(0, Math.trunc(input.foreignKeyCount));
  const v3 = Math.max(0, Math.trunc(input.orphanedItemCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (subCartCount=${v1}, foreignKeyCount=${v2}, orphanedItemCount=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, orphanedItemCount=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    subCartCount: v1,
    foreignKeyCount: v2,
    orphanedItemCount: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    subCartCount: v1,
    foreignKeyCount: v2,
    orphanedItemCount: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
