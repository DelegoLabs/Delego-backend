import { describe, it, expect, vi } from 'vitest';
import { SessionKeySigner } from './sessionKeySigner';
import type { SessionKeyPolicy } from './types';

const mockRedis = {
  get: vi.fn(),
  setex: vi.fn(),
  del: vi.fn(),
};
const mockDb = { query: vi.fn().mockResolvedValue({ rows: [] }) };
const mockVault = {
  read: vi.fn(),
  write: vi.fn().mockResolvedValue(undefined),
};

const signer = new SessionKeySigner(mockRedis as any, mockDb as any, mockVault as any);

const policy: SessionKeyPolicy = {
  allowedContracts: ['CONTRACT_A'],
  allowedMethods: ['transfer'],
  maxPerCallStroops: '5000000',
  maxTotalStroops: '50000000',
  expiresInSeconds: 3600,
};

describe('SessionKeySigner', () => {
  it('returns error for non-existent session key', async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    const result = await signer.signWithSessionKey({
      sessionPublicKey: 'GNONEXIST',
      contractCallXdr: 'AAAA',
      requestedAmountStroops: '1000',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns error when session key expired', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({
      sessionPublicKey: 'GTEST',
      userId: 'user-1',
      encryptedPrivateKey: 'enc',
      vaultKeyPath: 'path',
      spendingLimitStroops: '50000000',
      spentAmountStroops: '0',
      expiresAt: Math.floor(Date.now() / 1000) - 100, // expired
      createdAt: new Date().toISOString(),
      policy,
    }));
    const result = await signer.signWithSessionKey({
      sessionPublicKey: 'GTEST',
      contractCallXdr: 'AAAA',
      requestedAmountStroops: '1000',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('expired');
  });

  it('denies when amount exceeds remaining cap', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({
      sessionPublicKey: 'GTEST',
      userId: 'user-1',
      encryptedPrivateKey: 'enc',
      vaultKeyPath: 'path',
      spendingLimitStroops: '50000000',
      spentAmountStroops: '49999999',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      createdAt: new Date().toISOString(),
      policy,
    }));
    const result = await signer.signWithSessionKey({
      sessionPublicKey: 'GTEST',
      contractCallXdr: 'AAAA',
      requestedAmountStroops: '1000000', // exceeds remaining 1 stroop
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('exceeds remaining');
  });

  it('creates session key with Vault storage', async () => {
    const record = await signer.createSessionKey('user-1', 'GPUBKEY', 'ENC_KEY', policy);
    expect(record.sessionPublicKey).toBe('GPUBKEY');
    expect(record.spendingLimitStroops).toBe('50000000');
    expect(mockVault.write).toHaveBeenCalled();
    expect(mockRedis.setex).toHaveBeenCalled();
  });
});
