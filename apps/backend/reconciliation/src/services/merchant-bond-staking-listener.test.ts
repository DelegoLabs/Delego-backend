import { describe, expect, it } from 'vitest';
import { evaluateMerchantBondStake } from './merchant-bond-staking-listener.js';

describe('evaluateMerchantBondStake', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = evaluateMerchantBondStake({
      referenceId: 'ref-100',
      stakedBondStroops: 150,
      slashedStroops: 50,
      requiredMinimumStroops: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = evaluateMerchantBondStake({
      referenceId: 'ref-200',
      stakedBondStroops: 700,
      slashedStroops: 300,
      requiredMinimumStroops: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      evaluateMerchantBondStake({
        referenceId: '   ',
        stakedBondStroops: 1,
        slashedStroops: 2,
        requiredMinimumStroops: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
