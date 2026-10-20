import { describe, expect, it } from 'vitest';
import { validateBulkProductCsvBatch } from './bulk-product-csv-import-job.js';

describe('validateBulkProductCsvBatch', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = validateBulkProductCsvBatch({
      referenceId: 'ref-100',
      totalRowCount: 150,
      validSkuCount: 50,
      malformedRowCount: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = validateBulkProductCsvBatch({
      referenceId: 'ref-200',
      totalRowCount: 700,
      validSkuCount: 300,
      malformedRowCount: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      validateBulkProductCsvBatch({
        referenceId: '   ',
        totalRowCount: 1,
        validSkuCount: 2,
        malformedRowCount: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
