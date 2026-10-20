import { describe, expect, it } from 'vitest';
import { diagnoseWebSocketPingMissStall } from './websocket-stall-ping-miss-monitor.js';

describe('diagnoseWebSocketPingMissStall', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = diagnoseWebSocketPingMissStall({
      referenceId: 'ref-100',
      missedPingCount: 150,
      elapsedSincePongMs: 50,
      stallDeadlineMs: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = diagnoseWebSocketPingMissStall({
      referenceId: 'ref-200',
      missedPingCount: 700,
      elapsedSincePongMs: 300,
      stallDeadlineMs: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      diagnoseWebSocketPingMissStall({
        referenceId: '   ',
        missedPingCount: 1,
        elapsedSincePongMs: 2,
        stallDeadlineMs: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
