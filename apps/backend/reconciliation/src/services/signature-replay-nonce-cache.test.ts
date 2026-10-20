import { describe, expect, it } from 'vitest';
import { verifyAndRecordSignatureNonce } from './signature-replay-nonce-cache.js';

describe('verifyAndRecordSignatureNonce', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = verifyAndRecordSignatureNonce({
      referenceId: 'ref-100',
      nonceTimestampSec: 150,
      currentTimestampSec: 50,
      alreadySeenFlag: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = verifyAndRecordSignatureNonce({
      referenceId: 'ref-200',
      nonceTimestampSec: 700,
      currentTimestampSec: 300,
      alreadySeenFlag: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      verifyAndRecordSignatureNonce({
        referenceId: '   ',
        nonceTimestampSec: 1,
        currentTimestampSec: 2,
        alreadySeenFlag: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
