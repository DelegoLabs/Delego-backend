import { describe, expect, it } from 'vitest';
import { generateMerchantRevenueStatementCsv } from './merchant-revenue-statement-csv.js';

describe('generateMerchantRevenueStatementCsv', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = generateMerchantRevenueStatementCsv({
      referenceId: 'ref-100',
      grossVolumeCents: 150,
      platformFeeCents: 50,
      refundTotalCents: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = generateMerchantRevenueStatementCsv({
      referenceId: 'ref-200',
      grossVolumeCents: 700,
      platformFeeCents: 300,
      refundTotalCents: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      generateMerchantRevenueStatementCsv({
        referenceId: '   ',
        grossVolumeCents: 1,
        platformFeeCents: 2,
        refundTotalCents: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
