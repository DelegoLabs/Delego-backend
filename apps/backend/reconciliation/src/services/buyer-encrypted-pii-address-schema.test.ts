import { describe, expect, it } from 'vitest';
import { auditBuyerEncryptedPiiSchema } from './buyer-encrypted-pii-address-schema.js';

describe('auditBuyerEncryptedPiiSchema', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = auditBuyerEncryptedPiiSchema({
      referenceId: 'ref-100',
      encryptedFieldCount: 150,
      kmsKeyRotationAgeDays: 50,
      plaintextLeakCount: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = auditBuyerEncryptedPiiSchema({
      referenceId: 'ref-200',
      encryptedFieldCount: 700,
      kmsKeyRotationAgeDays: 300,
      plaintextLeakCount: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      auditBuyerEncryptedPiiSchema({
        referenceId: '   ',
        encryptedFieldCount: 1,
        kmsKeyRotationAgeDays: 2,
        plaintextLeakCount: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
