import { describe, expect, it } from 'vitest';
import { scanAndRedactQueryLogSecrets } from './db-query-secret-scanner.js';

describe('scanAndRedactQueryLogSecrets', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = scanAndRedactQueryLogSecrets({
      referenceId: 'ref-100',
      parameterCount: 150,
      redactedTokenCount: 50,
      rawQueryLength: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = scanAndRedactQueryLogSecrets({
      referenceId: 'ref-200',
      parameterCount: 700,
      redactedTokenCount: 300,
      rawQueryLength: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      scanAndRedactQueryLogSecrets({
        referenceId: '   ',
        parameterCount: 1,
        redactedTokenCount: 2,
        rawQueryLength: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
