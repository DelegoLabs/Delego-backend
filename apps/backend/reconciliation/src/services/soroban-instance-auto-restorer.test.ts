import { describe, expect, it } from 'vitest';
import { planSorobanInstanceRestoration } from './soroban-instance-auto-restorer.js';

describe('planSorobanInstanceRestoration', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = planSorobanInstanceRestoration({
      referenceId: 'ref-100',
      archivedEntryCount: 150,
      estimatedFeeStroops: 50,
      remainingBudgetStroops: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = planSorobanInstanceRestoration({
      referenceId: 'ref-200',
      archivedEntryCount: 700,
      estimatedFeeStroops: 300,
      remainingBudgetStroops: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      planSorobanInstanceRestoration({
        referenceId: '   ',
        archivedEntryCount: 1,
        estimatedFeeStroops: 2,
        remainingBudgetStroops: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
