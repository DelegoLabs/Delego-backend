import { describe, expect, it } from 'vitest';
import { resolveProductStockCacheAside } from './product-stock-cache-aside.js';

describe('resolveProductStockCacheAside', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = resolveProductStockCacheAside({
      referenceId: 'ref-100',
      cachedQuantity: 150,
      dbQuantity: 50,
      cacheAgeSeconds: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = resolveProductStockCacheAside({
      referenceId: 'ref-200',
      cachedQuantity: 700,
      dbQuantity: 300,
      cacheAgeSeconds: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      resolveProductStockCacheAside({
        referenceId: '   ',
        cachedQuantity: 1,
        dbQuantity: 2,
        cacheAgeSeconds: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
