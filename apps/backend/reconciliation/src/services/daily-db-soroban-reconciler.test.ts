import { describe, expect, it } from 'vitest';
import { reconcileDbWithSorobanEscrow } from './daily-db-soroban-reconciler.js';

describe('reconcileDbWithSorobanEscrow', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = reconcileDbWithSorobanEscrow({
      referenceId: 'ref-100',
      dbBalanceStroops: 150,
      sorobanBalanceStroops: 50,
      pendingTxCount: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = reconcileDbWithSorobanEscrow({
      referenceId: 'ref-200',
      dbBalanceStroops: 700,
      sorobanBalanceStroops: 300,
      pendingTxCount: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      reconcileDbWithSorobanEscrow({
        referenceId: '   ',
        dbBalanceStroops: 1,
        sorobanBalanceStroops: 2,
        pendingTxCount: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
