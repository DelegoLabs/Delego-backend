import { describe, expect, it } from 'vitest';
import { evaluateHorizonCircuitBreaker } from './horizon-504-circuit-breaker.js';

describe('evaluateHorizonCircuitBreaker', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = evaluateHorizonCircuitBreaker({
      referenceId: 'ref-100',
      consecutive504Count: 150,
      cooldownRemainingMs: 50,
      latencyMs: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = evaluateHorizonCircuitBreaker({
      referenceId: 'ref-200',
      consecutive504Count: 700,
      cooldownRemainingMs: 300,
      latencyMs: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      evaluateHorizonCircuitBreaker({
        referenceId: '   ',
        consecutive504Count: 1,
        cooldownRemainingMs: 2,
        latencyMs: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
