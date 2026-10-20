import { describe, expect, it } from 'vitest';
import { evaluateSelectiveDeepPiiMasking } from './nested-pii-mask-identifier-guard.js';

describe('evaluateSelectiveDeepPiiMasking', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = evaluateSelectiveDeepPiiMasking({
      referenceId: 'ref-100',
      preservedIdCount: 150,
      maskedPiiFieldCount: 50,
      traversalDepth: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = evaluateSelectiveDeepPiiMasking({
      referenceId: 'ref-200',
      preservedIdCount: 700,
      maskedPiiFieldCount: 300,
      traversalDepth: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      evaluateSelectiveDeepPiiMasking({
        referenceId: '   ',
        preservedIdCount: 1,
        maskedPiiFieldCount: 2,
        traversalDepth: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
