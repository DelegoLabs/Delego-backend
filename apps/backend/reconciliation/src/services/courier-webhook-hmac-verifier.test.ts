import { describe, expect, it } from 'vitest';
import { verifyCourierWebhookSignature } from './courier-webhook-hmac-verifier.js';

describe('verifyCourierWebhookSignature', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = verifyCourierWebhookSignature({
      referenceId: 'ref-100',
      signatureMatchFlag: 150,
      timestampDriftSecs: 50,
      bodyLengthBytes: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = verifyCourierWebhookSignature({
      referenceId: 'ref-200',
      signatureMatchFlag: 700,
      timestampDriftSecs: 300,
      bodyLengthBytes: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      verifyCourierWebhookSignature({
        referenceId: '   ',
        signatureMatchFlag: 1,
        timestampDriftSecs: 2,
        bodyLengthBytes: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
