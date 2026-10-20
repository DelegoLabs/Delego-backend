import { describe, expect, it } from 'vitest';
import { evaluateHorizonStreamFallback } from './horizon-stream-rpc-fallback.js';

describe('evaluateHorizonStreamFallback', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = evaluateHorizonStreamFallback({
      referenceId: 'ref-100',
      disconnectCount: 150,
      secondsSinceLastEvent: 50,
      rpcPollIntervalMs: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = evaluateHorizonStreamFallback({
      referenceId: 'ref-200',
      disconnectCount: 700,
      secondsSinceLastEvent: 300,
      rpcPollIntervalMs: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      evaluateHorizonStreamFallback({
        referenceId: '   ',
        disconnectCount: 1,
        secondsSinceLastEvent: 2,
        rpcPollIntervalMs: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
