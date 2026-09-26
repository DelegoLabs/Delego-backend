import { describe, it, expect, vi } from 'vitest';
import { BlendYieldCoordinator } from './blendYieldCoordinator';
import type { BlendYieldConfig } from './types';

const mockConfig: BlendYieldConfig = {
  poolContractId: 'CBLEND_POOL_TEST',
  assetAddress: 'CDHZFOHGBAL3PO6Y4KQP7QKQ6Z5JYUTZK5LONWHFJHHFOHOHFQ',
  rpcUrl: 'https://rpc-futurenet.stellar.org',
  networkPassphrase: 'Test SDF Future Network ; October 2022',
};

const mockDb = {
  query: vi.fn().mockResolvedValue({ rows: [] }),
} as any;

describe('BlendYieldCoordinator', () => {
  it('creates empty position on deposit failure', async () => {
    const coord = new BlendYieldCoordinator(mockConfig, mockDb);
    const result = await coord.depositToPool('esc-1', '1000000', { publicKey: () => 'GTEST' });
    expect(result.success).toBe(false);
    expect(result.position.escrowId).toBe('esc-1');
  });

  it('returns error when no position found for withdrawal', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    const coord = new BlendYieldCoordinator(mockConfig, mockDb);
    const result = await coord.withdrawFromPool('esc-2', { publicKey: () => 'GTEST' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No supply position');
  });

  it('returns null for checkPositionValue with no position', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    const coord = new BlendYieldCoordinator(mockConfig, mockDb);
    const value = await coord.checkPositionValue('esc-3');
    expect(value).toBeNull();
  });
});
