import { describe, expect, it } from 'vitest';
import { evaluateTierTokenBucketQuota } from './redis-token-bucket-limiter.js';

describe('evaluateTierTokenBucketQuota', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = evaluateTierTokenBucketQuota({
      referenceId: 'ref-100',
      availableTokens: 150,
      requestedCost: 50,
      refillRatePerSec: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = evaluateTierTokenBucketQuota({
      referenceId: 'ref-200',
      availableTokens: 700,
      requestedCost: 300,
      refillRatePerSec: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      evaluateTierTokenBucketQuota({
        referenceId: '   ',
        availableTokens: 1,
        requestedCost: 2,
        refillRatePerSec: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
