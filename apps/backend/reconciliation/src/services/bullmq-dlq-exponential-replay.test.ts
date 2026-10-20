import { describe, expect, it } from 'vitest';
import { computeDlqExponentialReplayDelay } from './bullmq-dlq-exponential-replay.js';

describe('computeDlqExponentialReplayDelay', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = computeDlqExponentialReplayDelay({
      referenceId: 'ref-100',
      attemptCount: 150,
      baseBackoffMs: 50,
      deadLetterDepth: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = computeDlqExponentialReplayDelay({
      referenceId: 'ref-200',
      attemptCount: 700,
      baseBackoffMs: 300,
      deadLetterDepth: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      computeDlqExponentialReplayDelay({
        referenceId: '   ',
        attemptCount: 1,
        baseBackoffMs: 2,
        deadLetterDepth: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
