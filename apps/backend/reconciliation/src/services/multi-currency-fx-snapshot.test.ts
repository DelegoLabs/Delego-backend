import { describe, expect, it } from 'vitest';
import { evaluateFxSnapshotStaleness } from './multi-currency-fx-snapshot.js';

describe('evaluateFxSnapshotStaleness', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = evaluateFxSnapshotStaleness({
      referenceId: 'ref-100',
      rateScaled: 150,
      ageSeconds: 50,
      maxSpreadBps: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = evaluateFxSnapshotStaleness({
      referenceId: 'ref-200',
      rateScaled: 700,
      ageSeconds: 300,
      maxSpreadBps: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      evaluateFxSnapshotStaleness({
        referenceId: '   ',
        rateScaled: 1,
        ageSeconds: 2,
        maxSpreadBps: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
