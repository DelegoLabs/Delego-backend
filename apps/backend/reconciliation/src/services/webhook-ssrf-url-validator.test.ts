import { describe, expect, it } from 'vitest';
import { validateMerchantWebhookUrl } from './webhook-ssrf-url-validator.js';

describe('validateMerchantWebhookUrl', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = validateMerchantWebhookUrl({
      referenceId: 'ref-100',
      resolvedIpClassCode: 150,
      portNumber: 50,
      redirectHopCount: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = validateMerchantWebhookUrl({
      referenceId: 'ref-200',
      resolvedIpClassCode: 700,
      portNumber: 300,
      redirectHopCount: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      validateMerchantWebhookUrl({
        referenceId: '   ',
        resolvedIpClassCode: 1,
        portNumber: 2,
        redirectHopCount: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
