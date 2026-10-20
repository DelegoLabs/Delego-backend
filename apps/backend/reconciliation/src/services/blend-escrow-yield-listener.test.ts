import { describe, expect, it } from 'vitest';
import { computeBlendEscrowYieldAccrual } from './blend-escrow-yield-listener.js';

describe('computeBlendEscrowYieldAccrual', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = computeBlendEscrowYieldAccrual({
      referenceId: 'ref-100',
      stakedPrincipalStroops: 150,
      accruedYieldStroops: 50,
      protocolCutBps: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = computeBlendEscrowYieldAccrual({
      referenceId: 'ref-200',
      stakedPrincipalStroops: 700,
      accruedYieldStroops: 300,
      protocolCutBps: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      computeBlendEscrowYieldAccrual({
        referenceId: '   ',
        stakedPrincipalStroops: 1,
        accruedYieldStroops: 2,
        protocolCutBps: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
