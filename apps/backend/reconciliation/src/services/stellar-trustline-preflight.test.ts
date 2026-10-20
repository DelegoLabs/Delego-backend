import { describe, expect, it } from 'vitest';
import { evaluateStellarTrustlinePreflight } from './stellar-trustline-preflight.js';

describe('evaluateStellarTrustlinePreflight', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = evaluateStellarTrustlinePreflight({
      referenceId: 'ref-100',
      trustlineLimitStroops: 150,
      requiredAmountStroops: 50,
      issuerFlagsBitmask: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = evaluateStellarTrustlinePreflight({
      referenceId: 'ref-200',
      trustlineLimitStroops: 700,
      requiredAmountStroops: 300,
      issuerFlagsBitmask: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      evaluateStellarTrustlinePreflight({
        referenceId: '   ',
        trustlineLimitStroops: 1,
        requiredAmountStroops: 2,
        issuerFlagsBitmask: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
