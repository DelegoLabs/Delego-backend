import { describe, expect, it } from 'vitest';
import { computeAuditBatchMerkleMemo } from './merkle-audit-stellar-memo.js';

describe('computeAuditBatchMerkleMemo', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = computeAuditBatchMerkleMemo({
      referenceId: 'ref-100',
      leafCount: 150,
      batchSeqNumber: 50,
      unanchoredLagSecs: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = computeAuditBatchMerkleMemo({
      referenceId: 'ref-200',
      leafCount: 700,
      batchSeqNumber: 300,
      unanchoredLagSecs: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      computeAuditBatchMerkleMemo({
        referenceId: '   ',
        leafCount: 1,
        batchSeqNumber: 2,
        unanchoredLagSecs: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
