/**
 * Path Payment Quote types.
 * Closes #283
 */

export interface PathPaymentQuoteRequest {
  sourceAsset: string;
  destinationAsset: string;
  destinationAmount: string;
  sourceAccount: string;
}

export interface PathHop {
  assetCode: string;
  issuer?: string;
}

export interface PathPaymentQuoteResponse {
  sourceAsset: string;
  sourceAmountMax: string;
  destinationAsset: string;
  destinationAmount: string;
  path: PathHop[];
  priceImpactPercent: number;
}
