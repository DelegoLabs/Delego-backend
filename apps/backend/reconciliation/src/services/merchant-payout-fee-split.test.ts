import { describe, expect, it } from 'vitest';
import { calculateMerchantPayoutFeeSplit } from './merchant-payout-fee-split.js';

describe('calculateMerchantPayoutFeeSplit', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = calculateMerchantPayoutFeeSplit({
      referenceId: 'ref-100',
      grossSettlementCents: 150,
      platformTakeBps: 50,
      networkFeeCents: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = calculateMerchantPayoutFeeSplit({
      referenceId: 'ref-200',
      grossSettlementCents: 700,
      platformTakeBps: 300,
      networkFeeCents: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      calculateMerchantPayoutFeeSplit({
        referenceId: '   ',
        grossSettlementCents: 1,
        platformTakeBps: 2,
        networkFeeCents: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
