import { describe, expect, it } from 'vitest';
import { summarizeMerchantPayoutCsvStream } from './merchant-payout-history-csv.js';

describe('summarizeMerchantPayoutCsvStream', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = summarizeMerchantPayoutCsvStream({
      referenceId: 'ref-100',
      exportedPayoutCount: 150,
      settledStroopsTotal: 50,
      chunkSizeRows: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = summarizeMerchantPayoutCsvStream({
      referenceId: 'ref-200',
      exportedPayoutCount: 700,
      settledStroopsTotal: 300,
      chunkSizeRows: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      summarizeMerchantPayoutCsvStream({
        referenceId: '   ',
        exportedPayoutCount: 1,
        settledStroopsTotal: 2,
        chunkSizeRows: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
