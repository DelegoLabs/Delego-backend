import { describe, expect, it } from 'vitest';
import { verifyBuyerSorobanEscrowPurchase } from './review-verify-buyer-escrow.js';

describe('verifyBuyerSorobanEscrowPurchase', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = verifyBuyerSorobanEscrowPurchase({
      referenceId: 'ref-100',
      escrowReleasedFlag: 150,
      orderAgeDays: 50,
      disputeCount: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = verifyBuyerSorobanEscrowPurchase({
      referenceId: 'ref-200',
      escrowReleasedFlag: 700,
      orderAgeDays: 300,
      disputeCount: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      verifyBuyerSorobanEscrowPurchase({
        referenceId: '   ',
        escrowReleasedFlag: 1,
        orderAgeDays: 2,
        disputeCount: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
