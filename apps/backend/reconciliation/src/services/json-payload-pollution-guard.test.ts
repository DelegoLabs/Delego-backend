import { describe, expect, it } from 'vitest';
import { validateJsonPayloadSafety } from './json-payload-pollution-guard.js';

describe('validateJsonPayloadSafety', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = validateJsonPayloadSafety({
      referenceId: 'ref-100',
      payloadSizeBytes: 150,
      nestingDepth: 50,
      forbiddenKeyCount: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = validateJsonPayloadSafety({
      referenceId: 'ref-200',
      payloadSizeBytes: 700,
      nestingDepth: 300,
      forbiddenKeyCount: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      validateJsonPayloadSafety({
        referenceId: '   ',
        payloadSizeBytes: 1,
        nestingDepth: 2,
        forbiddenKeyCount: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
