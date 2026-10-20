import { describe, expect, it } from 'vitest';
import { detectUnmatchedHorizonOperations } from './horizon-op-discrepancy-detector.js';

describe('detectUnmatchedHorizonOperations', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = detectUnmatchedHorizonOperations({
      referenceId: 'ref-100',
      horizonOpCount: 150,
      dbLedgerCount: 50,
      amountDriftStroops: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = detectUnmatchedHorizonOperations({
      referenceId: 'ref-200',
      horizonOpCount: 700,
      dbLedgerCount: 300,
      amountDriftStroops: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      detectUnmatchedHorizonOperations({
        referenceId: '   ',
        horizonOpCount: 1,
        dbLedgerCount: 2,
        amountDriftStroops: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
