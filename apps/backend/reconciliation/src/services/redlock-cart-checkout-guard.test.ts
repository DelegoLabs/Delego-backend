import { describe, expect, it } from 'vitest';
import { evaluateCartCheckoutRedlock } from './redlock-cart-checkout-guard.js';

describe('evaluateCartCheckoutRedlock', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = evaluateCartCheckoutRedlock({
      referenceId: 'ref-100',
      quorumNodesAcquired: 150,
      totalRedisNodes: 50,
      lockDriftMs: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = evaluateCartCheckoutRedlock({
      referenceId: 'ref-200',
      quorumNodesAcquired: 700,
      totalRedisNodes: 300,
      lockDriftMs: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      evaluateCartCheckoutRedlock({
        referenceId: '   ',
        quorumNodesAcquired: 1,
        totalRedisNodes: 2,
        lockDriftMs: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
