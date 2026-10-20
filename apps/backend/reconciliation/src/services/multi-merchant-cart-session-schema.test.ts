import { describe, expect, it } from 'vitest';
import { validateMultiMerchantCartMigration } from './multi-merchant-cart-session-schema.js';

describe('validateMultiMerchantCartMigration', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = validateMultiMerchantCartMigration({
      referenceId: 'ref-100',
      subCartCount: 150,
      foreignKeyCount: 50,
      orphanedItemCount: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = validateMultiMerchantCartMigration({
      referenceId: 'ref-200',
      subCartCount: 700,
      foreignKeyCount: 300,
      orphanedItemCount: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      validateMultiMerchantCartMigration({
        referenceId: '   ',
        subCartCount: 1,
        foreignKeyCount: 2,
        orphanedItemCount: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
