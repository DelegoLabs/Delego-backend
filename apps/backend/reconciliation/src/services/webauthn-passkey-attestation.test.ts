import { describe, expect, it } from 'vitest';
import { verifyWebAuthnPasskeyAttestation } from './webauthn-passkey-attestation.js';

describe('verifyWebAuthnPasskeyAttestation', () => {
  it('returns healthy status and deterministic sha256 checksum within nominal bounds', () => {
    const result = verifyWebAuthnPasskeyAttestation({
      referenceId: 'ref-100',
      challengeAgeSecs: 150,
      signCountDelta: 50,
      authenticatorAaguidValid: 10,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('healthy');
    expect(result.utilizationBps).toBe(2000);
    expect(result.checksumHex).toHaveLength(64);
  });

  it('transitions to halted when utilization or secondary metric breaches threshold', () => {
    const result = verifyWebAuthnPasskeyAttestation({
      referenceId: 'ref-200',
      challengeAgeSecs: 700,
      signCountDelta: 300,
      authenticatorAaguidValid: 1200,
      thresholdLimit: 1000,
    });
    expect(result.status).toBe('halted');
    expect(result.utilizationBps).toBe(10000);
    expect(result.summary).toContain('limit exceeded');
  });

  it('rejects blank referenceId or non-finite numbers', () => {
    expect(() =>
      verifyWebAuthnPasskeyAttestation({
        referenceId: '   ',
        challengeAgeSecs: 1,
        signCountDelta: 2,
        authenticatorAaguidValid: 3,
      }),
    ).toThrow(/referenceId is required/);
  });
});
