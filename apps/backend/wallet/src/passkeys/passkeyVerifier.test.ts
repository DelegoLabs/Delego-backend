import { describe, it, expect, vi } from 'vitest';
import { PasskeyVerifier } from './passkeyVerifier';

const mockRedis = {
  get: vi.fn(),
  setex: vi.fn(),
  del: vi.fn(),
};
const mockDb = { query: vi.fn().mockResolvedValue({ rows: [] }) };

const verifier = new PasskeyVerifier(mockRedis as any, mockDb as any);

describe('PasskeyVerifier', () => {
  it('generates a challenge with 5-minute TTL', async () => {
    const result = await verifier.generateChallenge('user-1');
    expect(result.challenge).toBeTruthy();
    expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(mockRedis.setex).toHaveBeenCalledWith(
      expect.stringContaining('webauthn_challenge:'),
      300,
      expect.any(String),
    );
  });

  it('rejects verification with non-existent challenge', async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    const result = await verifier.verifySignature({
      credentialId: 'cred-1',
      clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0',
      authenticatorData: 'AAAAAA',
      signature: 'SIG',
      challenge: 'NONEXISTENT',
    });
    expect(result.verified).toBe(false);
    expect(result.error).toContain('not found or expired');
  });

  it('rejects already-consumed challenge (replay attack)', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({
      userId: 'user-1',
      createdAt: Date.now(),
      consumed: true,
    }));
    const result = await verifier.verifySignature({
      credentialId: 'cred-1',
      clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0',
      authenticatorData: 'AAAAAA',
      signature: 'SIG',
      challenge: 'USED_CHALLENGE',
    });
    expect(result.verified).toBe(false);
    expect(result.error).toContain('replay attack');
  });

  it('links passkey to Stellar account', async () => {
    const mapping = await verifier.linkPasskeyToAccount(
      'user-1',
      'GAHZFOHGBAL3PO6Y4KQP7QKQ6Z5JYUTZK5LONWHFJHHFOHOHFQ',
      'cred-123',
      'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...',
    );
    expect(mapping.userId).toBe('user-1');
    expect(mapping.credentialId).toBe('cred-123');
    expect(mockDb.query).toHaveBeenCalled();
  });

  it('returns null for unlinked credential', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    const result = await verifier.getPasskeyMapping('NONEXIST');
    expect(result).toBeNull();
  });
});
