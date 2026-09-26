/**
 * Product catalog semantic vector search types.
 * Issue #263: pgvector-backed embedding search exposed through the gateway.
 */

export interface SearchProductsInput {
  query: string;
  category?: string;
  maxPriceStroops?: string;
  preferredAsset?: string;
  minMerchantRating?: number;
  /** Maximum number of results to return. Default: 10. */
  limit?: number;
}

export interface SearchProductResult {
  productId: string;
  merchantAddress: string;
  merchantName: string;
  title: string;
  description: string;
  priceStroops: string;
  assetCode: string;
  similarityScore: number; // 0.0 – 1.0
  inStock: boolean;
}
