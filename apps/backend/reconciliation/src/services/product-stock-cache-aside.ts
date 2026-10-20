import { createHash } from 'node:crypto';

export interface StockCacheAsideStateInput {
  referenceId: string;
  cachedQuantity: number;
  dbQuantity: number;
  cacheAgeSeconds: number;
  thresholdLimit?: number;
}

export interface StockCacheAsideState {
  referenceId: string;
  cachedQuantity: number;
  dbQuantity: number;
  cacheAgeSeconds: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function resolveProductStockCacheAside(input: StockCacheAsideStateInput): StockCacheAsideState {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('resolveProductStockCacheAside: referenceId is required');
  }
  if (
    !Number.isFinite(input.cachedQuantity) ||
    !Number.isFinite(input.dbQuantity) ||
    !Number.isFinite(input.cacheAgeSeconds)
  ) {
    throw new Error('resolveProductStockCacheAside: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.cachedQuantity));
  const v2 = Math.max(0, Math.trunc(input.dbQuantity));
  const v3 = Math.max(0, Math.trunc(input.cacheAgeSeconds));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (cachedQuantity=${v1}, dbQuantity=${v2}, cacheAgeSeconds=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, cacheAgeSeconds=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    cachedQuantity: v1,
    dbQuantity: v2,
    cacheAgeSeconds: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    cachedQuantity: v1,
    dbQuantity: v2,
    cacheAgeSeconds: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
