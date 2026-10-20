import { describe, expect, it } from 'vitest';
import { validatePromoDiscountMigrationState } from './merchant-promo-discount-schema.js';

describe('validatePromoDiscountMigrationState', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = validatePromoDiscountMigrationState({
      referenceId: 'ref-100',
      indexedColumnCount: 150,
      uniqueCodeConstraintFlag: 50,
      expiredRowCount: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = validatePromoDiscountMigrationState({
      referenceId: 'ref-200',
      indexedColumnCount: 700,
      uniqueCodeConstraintFlag: 300,
      expiredRowCount: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      validatePromoDiscountMigrationState({
        referenceId: '   ',
        indexedColumnCount: 1,
        uniqueCodeConstraintFlag: 2,
        expiredRowCount: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
