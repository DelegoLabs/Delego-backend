import { describe, expect, it } from 'vitest';
import { planEscrowReleaseReminderBatch } from './escrow-release-reminder-worker.js';

describe('planEscrowReleaseReminderBatch', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = planEscrowReleaseReminderBatch({
      referenceId: 'ref-100',
      pendingReleaseCount: 150,
      hoursSinceDelivery: 50,
      maxRemindersSent: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = planEscrowReleaseReminderBatch({
      referenceId: 'ref-200',
      pendingReleaseCount: 700,
      hoursSinceDelivery: 300,
      maxRemindersSent: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      planEscrowReleaseReminderBatch({
        referenceId: '   ',
        pendingReleaseCount: 1,
        hoursSinceDelivery: 2,
        maxRemindersSent: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
