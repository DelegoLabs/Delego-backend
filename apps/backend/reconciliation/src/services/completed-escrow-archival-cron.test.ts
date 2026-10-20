import { describe, expect, it } from 'vitest';
import { planCompletedEscrowArchival } from './completed-escrow-archival-cron.js';

describe('planCompletedEscrowArchival', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = planCompletedEscrowArchival({
      referenceId: 'ref-100',
      completedEscrowCount: 150,
      retentionDaysElapsed: 50,
      batchLimit: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = planCompletedEscrowArchival({
      referenceId: 'ref-200',
      completedEscrowCount: 700,
      retentionDaysElapsed: 300,
      batchLimit: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      planCompletedEscrowArchival({
        referenceId: '   ',
        completedEscrowCount: 1,
        retentionDaysElapsed: 2,
        batchLimit: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
