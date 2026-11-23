import { createLogger } from "@delegolabs/utils";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sequelize } from "../db.js";
import { json } from "@delegolabs/utils";

const log = createLogger("analytics:merchantDailyGmv");

export interface MerchantDailyGmvRow {
  bucketDay: string;
  merchantId: string;
  currency: string;
  totalOrders: number;
  grossVolumeStroops: string;
  totalPlatformFeesStroops: string;
  disputedOrdersCount: number;
}

export interface MerchantDailyGmvQueryOptions {
  /** Inclusive lower bound (day bucket). */
  from?: Date | string;
  /** Exclusive upper bound (day bucket). */
  to?: Date | string;
  /** Optional currency filter. */
  currency?: string;
  /** Maximum number of day buckets to return (default 30). */
  limit?: number;
}

export interface MerchantDailyGmvTotals {
  totalOrders: number;
  grossVolumeStroops: string;
  totalPlatformFeesStroops: string;
  disputedOrdersCount: number;
}

export interface MerchantDailyGmvResult {
  merchantId: string;
  currency: string | null;
  days: MerchantDailyGmvRow[];
  totals: MerchantDailyGmvTotals;
  queryTimeMs: number;
}

/**
 * Queries the `merchant_daily_gmu_summary` TimescaleDB continuous
 * aggregate for a single merchant. The continuous aggregate is
 * materialized by the hourly refresh policy, so this query hits a small
 * pre-aggregated hypertable instead of scanning `orders`.
 */
export class MerchantDailyGmvService {
  constructor(private readonly db = sequelize) {}

  async getMerchantDailyGmvImpl(
    merchantId: string,
    options: MerchantDailyGmvQueryOptions = {},
  ): Promise<MerchantDailyGmvResult> {
    if (!merchantId) throw new Error("merchantId is required");

    const limit = Math.min(Math.max(options.limit ?? 30, 1), 365);
    const currency = options.currency ?? null;
    const from = options.from ? new Date(options.from) : null;
    const to = options.to ? new Date(options.to) : null;

    const sql = `
      SELECT
        bucket_day,
        merchant_id,
        currency,
        total_orders,
        gross_volume_stroops,
        total_platform_fees_stroops,
        disputed_orders_count
      FROM merchant_daily_gmu_summary
      WHERE merchant_id = :merchantId
        AND (:currency::text IS NULL OR currency = :currency)
        AND (:from::timestamptz IS NULL OR bucket_day >= :from::timestamptz)
        AND (:to::timestamptz IS NULL OR bucket_day < :to::timestamptz)
      ORDER BY bucket_day DESC
      LIMIT :limit
    `;

    const startedAt = performance.now();
    const [rows] = (await this.db.query(sql, {
      replacements: {
        merchantId,
        currency,
        from,
        to,
        limit,
      },
      type: "SELECT",
    })) as [Array<Record<string, unknown>>, unknown];
    const queryTimeMs = performance.now() - startedAt;

    const days: MerchantDailyGmvRow[] = rows.map((r) => ({
      bucketDay: new Date(r.bucket_day as string).toISOString(),
      merchantId: String(r.merchant_id),
      currency: String(r.currency),
      totalOrders: Number(r.total_orders),
      grossVolumeStroops: String(r.gross_volume_stroops),
      totalPlatformFeesStroops: String(r.total_platform_fees_stroops),
      disputedOrdersCount: Number(r.disputed_orders_count),
    }));

    const totals = days.reduce<MerchantDailyGmvTotals>(
      (acc, row) => ({
        totalOrders: acc.totalOrders + row.totalOrders,
        grossVolumeStroops: (
          BigInt(acc.grossVolumeStroops) + BigInt(row.grossVolumeStroops)
        ).toString(),
        totalPlatformFeesStroops: (
          BigInt(acc.totalPlatformFeesStroops) + BigInt(row.totalPlatformFeesStroops)
        ).toString(),
        disputedOrdersCount: acc.disputedOrdersCount + row.disputedOrdersCount,
      }),
      {
        totalOrders: 0,
        grossVolumeStroops: "0",
        totalPlatformFeesStroops: "0",
        disputedOrdersCount: 0,
      },
    );

    log.debug("merchant daily gmv query", {
      merchantId,
      currency,
      rows: days.length,
      queryTimeMs,
    });

    return { merchantId, currency, days, totals, queryTimeMs };
  }
}

export const merchantDailyGmvService = new MerchantDailyGmvService();

export async function getMerchantDailyGmvHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
): Promise<void> {
  const merchantId = params.merchantId as string | undefined;
  if (!merchantId) {
    json(res, 400, { error: "merchantId is required" });
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const currency = url.searchParams.get("currency");
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;

  try {
    const result = await merchantDailyGmvService.getMerchantDailyGmvImpl(merchantId, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      currency: currency ?? undefined,
      limit,
    });
    json(res, 200, { data: result });
    return;
  } catch (err) {
    log.error("failed to query merchant daily gmv", {
      merchantId,
      error: (err as Error).message,
    });
    json(res, 500, { error: "internal error" });
    return;
  }
}
