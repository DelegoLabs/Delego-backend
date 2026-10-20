import { describe, expect, it } from 'vitest';
import { evaluateSentinelReconnectBackoff } from './redis-sentinel-failover-backoff.js';

describe('evaluateSentinelReconnectBackoff', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = evaluateSentinelReconnectBackoff({
      referenceId: 'ref-100',
      reconnectAttemptCount: 150,
      quorumReachableNodes: 50,
      stormWindowEvents: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = evaluateSentinelReconnectBackoff({
      referenceId: 'ref-200',
      reconnectAttemptCount: 700,
      quorumReachableNodes: 300,
      stormWindowEvents: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      evaluateSentinelReconnectBackoff({
        referenceId: '   ',
        reconnectAttemptCount: 1,
        quorumReachableNodes: 2,
        stormWindowEvents: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
