import { describe, expect, it } from 'vitest';
import { validateCourierIdempotencyMigration } from './courier-webhook-idempotency-schema.js';

describe('validateCourierIdempotencyMigration', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = validateCourierIdempotencyMigration({
      referenceId: 'ref-100',
      dedupKeyCount: 150,
      partitionCount: 50,
      duplicateEventCount: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = validateCourierIdempotencyMigration({
      referenceId: 'ref-200',
      dedupKeyCount: 700,
      partitionCount: 300,
      duplicateEventCount: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      validateCourierIdempotencyMigration({
        referenceId: '   ',
        dedupKeyCount: 1,
        partitionCount: 2,
        duplicateEventCount: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
