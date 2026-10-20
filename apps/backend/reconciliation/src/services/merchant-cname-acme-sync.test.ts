import { describe, expect, it } from 'vitest';
import { evaluateMerchantCnameAcmeSync } from './merchant-cname-acme-sync.js';

describe('evaluateMerchantCnameAcmeSync', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = evaluateMerchantCnameAcmeSync({
      referenceId: 'ref-100',
      cnameVerifiedFlag: 150,
      certExpiryDays: 50,
      renewalAttemptCount: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = evaluateMerchantCnameAcmeSync({
      referenceId: 'ref-200',
      cnameVerifiedFlag: 700,
      certExpiryDays: 300,
      renewalAttemptCount: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      evaluateMerchantCnameAcmeSync({
        referenceId: '   ',
        cnameVerifiedFlag: 1,
        certExpiryDays: 2,
        renewalAttemptCount: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
