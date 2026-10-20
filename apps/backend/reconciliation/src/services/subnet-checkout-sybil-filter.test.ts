import { describe, expect, it } from 'vitest';
import { evaluateSubnetCheckoutVelocity } from './subnet-checkout-sybil-filter.js';

describe('evaluateSubnetCheckoutVelocity', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = evaluateSubnetCheckoutVelocity({
      referenceId: 'ref-100',
      requestsInWindow: 150,
      uniqueWalletsInSubnet: 50,
      failedPaymentCount: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = evaluateSubnetCheckoutVelocity({
      referenceId: 'ref-200',
      requestsInWindow: 700,
      uniqueWalletsInSubnet: 300,
      failedPaymentCount: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      evaluateSubnetCheckoutVelocity({
        referenceId: '   ',
        requestsInWindow: 1,
        uniqueWalletsInSubnet: 2,
        failedPaymentCount: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
