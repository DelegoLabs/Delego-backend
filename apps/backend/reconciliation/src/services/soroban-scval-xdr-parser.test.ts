import { describe, expect, it } from 'vitest';
import { parseTypedSorobanScValSummary } from './soroban-scval-xdr-parser.js';

describe('parseTypedSorobanScValSummary', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = parseTypedSorobanScValSummary({
      referenceId: 'ref-100',
      mapEntryCount: 150,
      vectorLength: 50,
      decodeErrorCount: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = parseTypedSorobanScValSummary({
      referenceId: 'ref-200',
      mapEntryCount: 700,
      vectorLength: 300,
      decodeErrorCount: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      parseTypedSorobanScValSummary({
        referenceId: '   ',
        mapEntryCount: 1,
        vectorLength: 2,
        decodeErrorCount: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
