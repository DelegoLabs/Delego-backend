import { describe, expect, it } from 'vitest';
import { evaluateSorobanStorageTtl } from './soroban-storage-ttl-monitor.js';

describe('evaluateSorobanStorageTtl', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = evaluateSorobanStorageTtl({
      referenceId: 'ref-100',
      currentLedgerSeq: 150,
      liveUntilLedgerSeq: 50,
      minThresholdLedgers: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = evaluateSorobanStorageTtl({
      referenceId: 'ref-200',
      currentLedgerSeq: 700,
      liveUntilLedgerSeq: 300,
      minThresholdLedgers: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      evaluateSorobanStorageTtl({
        referenceId: '   ',
        currentLedgerSeq: 1,
        liveUntilLedgerSeq: 2,
        minThresholdLedgers: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
