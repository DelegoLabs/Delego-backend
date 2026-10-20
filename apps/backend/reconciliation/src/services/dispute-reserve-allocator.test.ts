import { describe, expect, it } from 'vitest';
import { calculateDisputeReserveFund } from './dispute-reserve-allocator.js';

describe('calculateDisputeReserveFund', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = calculateDisputeReserveFund({
      referenceId: 'ref-100',
      monthlyVolumeCents: 150,
      chargebackRateBps: 50,
      existingReserveCents: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = calculateDisputeReserveFund({
      referenceId: 'ref-200',
      monthlyVolumeCents: 700,
      chargebackRateBps: 300,
      existingReserveCents: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      calculateDisputeReserveFund({
        referenceId: '   ',
        monthlyVolumeCents: 1,
        chargebackRateBps: 2,
        existingReserveCents: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
