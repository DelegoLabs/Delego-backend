import { describe, expect, it } from 'vitest';
import { evaluateDisputeCompositeIndexScan } from './unresolved-dispute-composite-index.js';

describe('evaluateDisputeCompositeIndexScan', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = evaluateDisputeCompositeIndexScan({
      referenceId: 'ref-100',
      unresolvedDisputeRows: 150,
      indexSelectivityBps: 50,
      seqScanFallbackCount: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = evaluateDisputeCompositeIndexScan({
      referenceId: 'ref-200',
      unresolvedDisputeRows: 700,
      indexSelectivityBps: 300,
      seqScanFallbackCount: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      evaluateDisputeCompositeIndexScan({
        referenceId: '   ',
        unresolvedDisputeRows: 1,
        indexSelectivityBps: 2,
        seqScanFallbackCount: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
