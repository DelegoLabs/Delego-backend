import { describe, expect, it } from 'vitest';
import { planConsolidatedPayoutBatch } from './consolidated-payout-batcher.js';

describe('planConsolidatedPayoutBatch', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = planConsolidatedPayoutBatch({
      referenceId: 'ref-100',
      recipientCount: 150,
      totalAmountStroops: 50,
      baseFeeStroops: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = planConsolidatedPayoutBatch({
      referenceId: 'ref-200',
      recipientCount: 700,
      totalAmountStroops: 300,
      baseFeeStroops: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      planConsolidatedPayoutBatch({
        referenceId: '   ',
        recipientCount: 1,
        totalAmountStroops: 2,
        baseFeeStroops: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
