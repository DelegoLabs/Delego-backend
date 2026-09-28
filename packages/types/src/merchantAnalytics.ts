/**
 * Merchant Continuous Aggregates Analytics Types (Issue #377)
 */

export type AnalyticsTimeBucket = "1m" | "1h" | "1d";

export interface MerchantSalesAggregate {
  bucket: string; // ISO 8601 timestamp
  merchantId: string;
  volume: string; // aggregated amount/volume
  orderCount: number;
  avgOrderValue?: string;
}

export interface MerchantAnalyticsQuery {
  merchantId: string;
  bucketInterval?: AnalyticsTimeBucket;
  startTime?: string;
  endTime?: string;
  limit?: number;
}

export interface MerchantAnalyticsResponse {
  merchantId: string;
  interval: AnalyticsTimeBucket;
  startTime: string;
  endTime: string;
  aggregates: MerchantSalesAggregate[];
  totalVolume: string;
  totalOrders: number;
}
