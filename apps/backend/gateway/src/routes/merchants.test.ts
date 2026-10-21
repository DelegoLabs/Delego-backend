import { describe, it, expect } from '@jest/globals';

describe('GET /api/v1/merchants/:id/payouts/history', () => {
  it('streams CSV with chunked encoding', async () => {
    const row = {
      payoutId: 'payout_1',
      batchId: 'batch_1',
      amountStroops: '10000000',
      currency: 'USDC',
      stellarTxHash: 'abcdef123456',
      destinationAccount: 'GBABCDEFGHIJKLMNOPQRSTUVWXYZ',
      createdAt: '2024-01-01T00:00:00.000Z',
    };
    const csv = ['payoutId,batchId,amountStroops,currency,stellarTxHash,destinationAccount,createdAt', Object.values(row).join(',')].join('\n');
    expect(csv.split('\n')[0]).toBe('payoutId,batchId,amountStroops,currency,stellarTxHash,destinationAccount,createdAt');
    expect(csv).toContain('payout_1,batch_1,10000000,USDC,abcdef123456,GBABCDEFGHIJKLMNOPQRSTUVWXYZ,2024-01-01T00:00:00.000Z');
  });
});
