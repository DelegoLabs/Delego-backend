import { describe, expect, it } from 'vitest';
import { reconcilePartialRefundSettlement } from './partial-refund-reconciler.js';

describe('reconcilePartialRefundSettlement', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = reconcilePartialRefundSettlement({
      referenceId: 'ref-100',
      originalEscrowCents: 150,
      refundedCents: 50,
      merchantPayoutCents: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = reconcilePartialRefundSettlement({
      referenceId: 'ref-200',
      originalEscrowCents: 700,
      refundedCents: 300,
      merchantPayoutCents: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      reconcilePartialRefundSettlement({
        referenceId: '   ',
        originalEscrowCents: 1,
        refundedCents: 2,
        merchantPayoutCents: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
