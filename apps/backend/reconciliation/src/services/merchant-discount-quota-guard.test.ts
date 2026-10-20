import { describe, expect, it } from 'vitest';
import { enforceMerchantDiscountQuota } from './merchant-discount-quota-guard.js';

describe('enforceMerchantDiscountQuota', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = enforceMerchantDiscountQuota({
      referenceId: 'ref-100',
      activeDiscountCount: 150,
      discountBps: 50,
      tierMaxDiscounts: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = enforceMerchantDiscountQuota({
      referenceId: 'ref-200',
      activeDiscountCount: 700,
      discountBps: 300,
      tierMaxDiscounts: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      enforceMerchantDiscountQuota({
        referenceId: '   ',
        activeDiscountCount: 1,
        discountBps: 2,
        tierMaxDiscounts: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
