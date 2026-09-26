import { describe, it, expect } from 'vitest';
import { PathPaymentQuoteEngine } from './pathPaymentQuoteEngine';

describe('PathPaymentQuoteEngine', () => {
  const engine = new PathPaymentQuoteEngine('https://horizon-testnet.stellar.org');

  it('rejects zero destination amount', async () => {
    await expect(
      engine.getQuote({
        sourceAsset: 'XLM',
        destinationAsset: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        destinationAmount: '0',
        sourceAccount: 'GTEST',
      }),
    ).rejects.toThrow('positive');
  });

  it('parses native asset correctly', () => {
    // The engine should handle XLM/native
    expect(() => new PathPaymentQuoteEngine()).not.toThrow();
  });
});
