/**
 * Multi-Currency Payment Types
 * Support for multiple Stellar assets, path payments, and FX rates
 */

export type CurrencyType = "native" | "issued";
export type PaymentStatus = "pending" | "converting" | "settled" | "failed" | "cancelled";
export type SettlementStatus = "pending" | "in_progress" | "completed" | "failed";

export interface SupportedCurrency {
  code: string;
  issuer: string;
  assetType: CurrencyType;
  decimals: number;
  fxProvider: string;
  settlementEnabled: boolean;
  complianceFlags: string[];
}

export interface FXRate {
  baseCurrency: string;
  quoteCurrency: string;
  rate: string; // quote per base
  source: string;
  timestamp: string;
  validUntil: string;
  spread: string;
}

export interface ConversionPath {
  from: string;
  to: string;
  rate: string;
  amountOut: string;
}

export interface MultiCurrencyPayment {
  id: string;
  sourceCurrency: string;
  sourceAmount: string;
  destinationCurrency: string;
  destinationAmount: string;
  fxRate: FXRate;
  conversionPath: ConversionPath[];
  settlementCurrency: string;
  status: PaymentStatus;
  settlementStatus?: SettlementStatus;
  stellarTransactionHash?: string;
  pathPaymentId?: string;
  createdAt: string;
  completedAt?: string;
  failedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface CurrencyExposure {
  currency: string;
  grossAmount: string;
  netAmount: string;
  unrealizedPnL: string;
  hedgeRatio: number;
  var95: string; // Value at Risk 95%
  var99: string; // Value at Risk 99%
  marginRequirement: string;
  collateralRequired: string;
  exposureDate: string;
  hedgeStatus: "unhedged" | "partially_hedged" | "fully_hedged";
}

export interface FXRateRequest {
  baseCurrency: string;
  quoteCurrency: string;
  amount?: string;
}

export interface FXRateResponse {
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  source: string;
  timestamp: string;
  validUntil: string;
  spread: string;
  midRate: string;
  bid: string;
  ask: string;
}

export interface MultiCurrencyPaymentRequest {
  sourceCurrency: string;
  sourceAmount: string;
  destinationCurrency: string;
  destinationAddress: string;
  destinationAmount?: string;
  settlementCurrency?: string;
  metadata?: Record<string, unknown>;
  requireFxRateLock?: boolean;
  fxRate?: FXRate;
}

export interface MultiCurrencyPaymentResponse {
  paymentId: string;
  sourceCurrency: string;
  sourceAmount: string;
  destinationCurrency: string;
  destinationAmount: string;
  fxRate: FXRate;
  conversionPath: ConversionPath[];
  stellarTransactionHash?: string;
  estimatedSettlementTime: string;
}

export interface CurrencySettlement {
  id: string;
  currency: string;
  totalIn: string;
  totalOut: string;
  netAmount: string;
  settlementDate: string;
  ledgerSequence: number;
  status: SettlementStatus;
  transactions: string[];
  createdAt: string;
  completedAt?: string;
}

export interface CurrencyExposureReport {
  date: string;
  totalGrossExposure: string;
  totalNetExposure: string;
  currencies: CurrencyExposure[];
  hedgeSummary: {
    totalHedged: string;
    totalUnhedged: string;
    hedgeCoverage: number;
  };
}

export interface ComplianceCheckRequest {
  currency: string;
  amount: string;
  jurisdiction: string;
  partyA: string;
  partyB: string;
}

export interface ComplianceCheckResponse {
  compliant: boolean;
  reason?: string;
  requiredActions?: string[];
  jurisdictionFlags: string[];
  regulatoryInfo: {
    reportingRequired: boolean;
    documentationRequired: boolean;
    limitExceeded: boolean;
  };
}

export interface MultiCurrencyWallet {
  currency: string;
  balance: string;
  availableBalance: string;
  reservedBalance: string;
  currencyInfo: SupportedCurrency;
  lastUpdated: string;
}

export interface PathPaymentParams {
  sourceAddress: string;
  sourceAmount: string;
  destinationAddress: string;
  destinationMin: string;
  path: string[]; // Asset codes
}

export interface AutoRouteRequest {
  sourceCurrency: string;
  sourceAmount: string;
  destinationCurrency: string;
}

export interface AutoRouteResponse {
  route: ConversionPath[];
  estimatedRate: string;
  minimumRate: string;
  pathLength: number;
  stellarTransactionFee: string;
}

export interface CurrencyRiskMetrics {
  currency: string;
  totalExposure: string;
  var95: string;
  var99: string;
  maxDrawdown: string;
  stressTestResults: {
    marketCrash: string;
    liquidityCrisis: string;
    currencyDepeg: string;
  };
  marginCallThreshold: string;
  liquidationPrice?: string;
}
