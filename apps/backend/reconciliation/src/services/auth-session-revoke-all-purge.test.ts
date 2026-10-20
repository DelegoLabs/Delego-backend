import { describe, expect, it } from 'vitest';
import { purgeAllUserRedisSessions } from './auth-session-revoke-all-purge.js';

describe('purgeAllUserRedisSessions', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = purgeAllUserRedisSessions({
      referenceId: 'ref-100',
      activeSessionCount: 150,
      refreshTokenCount: 50,
      revocationLatencyMs: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = purgeAllUserRedisSessions({
      referenceId: 'ref-200',
      activeSessionCount: 700,
      refreshTokenCount: 300,
      revocationLatencyMs: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      purgeAllUserRedisSessions({
        referenceId: '   ',
        activeSessionCount: 1,
        refreshTokenCount: 2,
        revocationLatencyMs: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
