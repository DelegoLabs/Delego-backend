/**
 * Multi-Merchant Product Price Comparison — Issue #531
 *
 * GET /api/v1/catalog/compare
 *
 * Searches active products across all merchants, looks up per-merchant
 * shipping fees for the buyer's destination country, and returns a ranked
 * list of offers scored by: 40 % price + 30 % shipping + 30 % merchant rating.
 */
import { Pool } from "pg";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("payments:catalog", process.env.LOG_LEVEL ?? "info");

// ── DB pool (lazy) ────────────────────────────────────────────────────────────

let _pool: Pool | null = null;

function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString:
        process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego",
    });
  }
  return _pool;
}

export function _setCatalogPoolForTesting(p: Pool): void { _pool = p; }
export function _resetCatalogPool(): void { _pool = null; }

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MultiMerchantSearchQuery {
  keywords: string;
  destinationCountry: string;
  maxResults?: number;
}

export interface RankedMerchantProductOffer {
  merchantId: string;
  merchantName: string;
  productId: string;
  productTitle: string;
  unitPriceStroops: string;
  shippingFeeStroops: string;
  totalCostStroops: string;
  merchantRating: number;
  rankScore: number;
}

// ── Validation ────────────────────────────────────────────────────────────────

export function validateSearchQuery(raw: Record<string, unknown>): MultiMerchantSearchQuery {
  if (!raw.keywords || typeof raw.keywords !== "string" || raw.keywords.trim().length === 0) {
    throw new Error("keywords is required");
  }
  if (!raw.destinationCountry || typeof raw.destinationCountry !== "string") {
    throw new Error("destinationCountry (ISO 3166-1 alpha-2) is required");
  }
  const maxResults = raw.maxResults !== undefined
    ? Math.min(50, Math.max(1, Number(raw.maxResults)))
    : 20;

  return {
    keywords: raw.keywords.trim(),
    destinationCountry: (raw.destinationCountry as string).toUpperCase().slice(0, 2),
    maxResults,
  };
}

// ── Ranking ───────────────────────────────────────────────────────────────────

/**
 * Scores an offer: lower total cost = higher score.
 * Weights: 40 % unit price, 30 % shipping fee, 30 % merchant rating.
 *
 * All cost components are normalised to [0,1] relative to the max values in
 * the result set, then inverted so a *lower* cost gives a *higher* score.
 * Rating is already in [0,100] and normalised to [0,1].
 */
export function scoreOffers(offers: Array<{
  unitPriceStroops: bigint;
  shippingFeeStroops: bigint;
  reputationScore: number;
}>): number[] {
  if (offers.length === 0) return [];

  const maxPrice    = offers.reduce((m, o) => o.unitPriceStroops    > m ? o.unitPriceStroops    : m, 0n);
  const maxShipping = offers.reduce((m, o) => o.shippingFeeStroops  > m ? o.shippingFeeStroops  : m, 0n);

  return offers.map((o) => {
    const priceScore    = maxPrice    > 0n ? 1 - Number(o.unitPriceStroops)   / Number(maxPrice)    : 1;
    const shippingScore = maxShipping > 0n ? 1 - Number(o.shippingFeeStroops) / Number(maxShipping) : 1;
    const ratingScore   = o.reputationScore / 100;
    return 0.4 * priceScore + 0.3 * shippingScore + 0.3 * ratingScore;
  });
}

// ── Service ───────────────────────────────────────────────────────────────────

export async function searchAndRankOffers(
  query: MultiMerchantSearchQuery
): Promise<RankedMerchantProductOffer[]> {
  const { keywords, destinationCountry, maxResults = 20 } = query;

  // Build a set of tsquery tokens from the keywords for full-text matching.
  const tokens = keywords
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
    .filter(Boolean)
    .join(" & ");

  const { rows } = await getPool().query<{
    merchant_id: string;
    merchant_name: string;
    product_id: string;
    product_title: string;
    unit_price_stroops: string;
    shipping_fee_stroops: string;
    reputation_score: number;
  }>(
    `SELECT
       m.id               AS merchant_id,
       COALESCE(m.name, m.store_name) AS merchant_name,
       p.id               AS product_id,
       p.title            AS product_title,
       p.price_stroops::text AS unit_price_stroops,
       COALESCE(sm.fee_stroops, 0)::text AS shipping_fee_stroops,
       m.reputation_score
     FROM products p
     JOIN merchants m ON m.id = p.merchant_id
     LEFT JOIN merchant_shipping_matrices sm
            ON sm.merchant_id = m.id
           AND sm.dest_country = $2
    WHERE p.status = 'active'
      AND p.is_listed = true
      AND (
        p.title        ILIKE $3
        OR p.description ILIKE $3
        OR p.category    ILIKE $3
      )
    LIMIT $1`,
    [maxResults * 3, destinationCountry, `%${keywords}%`]
  );

  if (rows.length === 0) return [];

  const scores = scoreOffers(
    rows.map((r) => ({
      unitPriceStroops: BigInt(r.unit_price_stroops),
      shippingFeeStroops: BigInt(r.shipping_fee_stroops),
      reputationScore: r.reputation_score,
    }))
  );

  const ranked: RankedMerchantProductOffer[] = rows.map((row, i) => {
    const unit = BigInt(row.unit_price_stroops);
    const ship = BigInt(row.shipping_fee_stroops);
    return {
      merchantId: row.merchant_id,
      merchantName: row.merchant_name,
      productId: row.product_id,
      productTitle: row.product_title,
      unitPriceStroops: row.unit_price_stroops,
      shippingFeeStroops: row.shipping_fee_stroops,
      totalCostStroops: (unit + ship).toString(),
      merchantRating: row.reputation_score,
      rankScore: Math.round(scores[i] * 10_000) / 10_000,
    };
  });

  ranked.sort((a, b) => b.rankScore - a.rankScore);
  return ranked.slice(0, maxResults);
}
