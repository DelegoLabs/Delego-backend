import { createHash } from 'node:crypto';

export interface PromoDiscountSchemaCheckInput {
  referenceId: string;
  indexedColumnCount: number;
  uniqueCodeConstraintFlag: number;
  expiredRowCount: number;
  thresholdLimit?: number;
}

export interface PromoDiscountSchemaCheck {
  referenceId: string;
  indexedColumnCount: number;
  uniqueCodeConstraintFlag: number;
  expiredRowCount: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function validatePromoDiscountMigrationState(input: PromoDiscountSchemaCheckInput): PromoDiscountSchemaCheck {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('validatePromoDiscountMigrationState: referenceId is required');
  }
  if (
    !Number.isFinite(input.indexedColumnCount) ||
    !Number.isFinite(input.uniqueCodeConstraintFlag) ||
    !Number.isFinite(input.expiredRowCount)
  ) {
    throw new Error('validatePromoDiscountMigrationState: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.indexedColumnCount));
  const v2 = Math.max(0, Math.trunc(input.uniqueCodeConstraintFlag));
  const v3 = Math.max(0, Math.trunc(input.expiredRowCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (indexedColumnCount=${v1}, uniqueCodeConstraintFlag=${v2}, expiredRowCount=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, expiredRowCount=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    indexedColumnCount: v1,
    uniqueCodeConstraintFlag: v2,
    expiredRowCount: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    indexedColumnCount: v1,
    uniqueCodeConstraintFlag: v2,
    expiredRowCount: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
