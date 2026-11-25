/**
 * Public Product Review Feed — Issue #521
 *
 * GET  /api/v1/reviews            — paginated feed with star filter + sorting
 * POST /api/v1/reviews/:id/helpful — atomic helpful-vote with deduplication
 */
import { Pool } from "pg";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("payments:reviews", process.env.LOG_LEVEL ?? "info");

// ── DB pool (lazy) ───────────────────────────────────────────────────────────

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

export function _setReviewPoolForTesting(p: Pool): void { _pool = p; }
export function _resetReviewPool(): void { _pool = null; }

// ── Types ────────────────────────────────────────────────────────────────────

export type ReviewSortBy = "recent" | "rating_high" | "rating_low" | "helpful";

export interface ReviewFeedQuery {
  productId?: string;
  merchantId?: string;
  starFilter?: number;
  page: number;
  pageSize: number;
  sortBy: ReviewSortBy;
}

export interface ReviewFeedItem {
  id: string;
  productId: string;
  buyerAddress: string;
  rating: number;
  title: string;
  content: string;
  helpfulCount: number;
  isVerifiedPurchase: boolean;
  orderCompletedAt: string | null;
  createdAt: string;
}

export interface ReviewFeedPage {
  data: ReviewFeedItem[];
  page: number;
  pageSize: number;
  total: number;
}

// ── Validation ───────────────────────────────────────────────────────────────

export function validateReviewFeedQuery(raw: Record<string, unknown>): ReviewFeedQuery {
  const page = Math.max(1, Number(raw.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(raw.pageSize) || 20));
  const starFilter = raw.starFilter !== undefined ? Number(raw.starFilter) : undefined;
  const sortBy = (["recent", "rating_high", "rating_low", "helpful"].includes(raw.sortBy as string)
    ? raw.sortBy
    : "recent") as ReviewSortBy;

  if (starFilter !== undefined && (starFilter < 1 || starFilter > 5 || !Number.isInteger(starFilter))) {
    throw new Error("starFilter must be an integer between 1 and 5");
  }

  return {
    productId: typeof raw.productId === "string" ? raw.productId : undefined,
    merchantId: typeof raw.merchantId === "string" ? raw.merchantId : undefined,
    starFilter,
    page,
    pageSize,
    sortBy,
  };
}

// ── Service ──────────────────────────────────────────────────────────────────

const SORT_CLAUSE: Record<ReviewSortBy, string> = {
  recent:      "r.created_at DESC",
  rating_high: "r.rating DESC, r.created_at DESC",
  rating_low:  "r.rating ASC,  r.created_at DESC",
  helpful:     "r.helpful_count DESC, r.created_at DESC",
};

export async function getReviewFeed(query: ReviewFeedQuery): Promise<ReviewFeedPage> {
  const { productId, merchantId, starFilter, page, pageSize, sortBy } = query;
  const offset = (page - 1) * pageSize;

  const params: unknown[] = [];
  const where: string[] = ["r.is_visible = true"];

  if (productId) {
    params.push(productId);
    where.push(`r.product_id = $${params.length}`);
  }

  if (merchantId) {
    params.push(merchantId);
    where.push(`p.merchant_id = $${params.length}`);
  }

  if (starFilter !== undefined) {
    params.push(starFilter);
    where.push(`r.rating = $${params.length}`);
  }

  const whereClause = where.join(" AND ");
  const orderClause = SORT_CLAUSE[sortBy];

  // Count query
  const countResult = await getPool().query<{ total: string }>(
    `SELECT COUNT(*) AS total
       FROM reviews r
       LEFT JOIN products p ON p.id = r.product_id
      WHERE ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0]?.total ?? "0", 10);

  // Data query — LEFT JOIN payment_records to surface verified purchases and
  // order completion timestamp in a single round-trip.
  params.push(pageSize, offset);
  const result = await getPool().query<{
    id: string;
    product_id: string;
    buyer_address: string;
    rating: number;
    title: string;
    content: string;
    helpful_count: number;
    order_id: string;
    created_at: string;
    settled_at: string | null;
  }>(
    `SELECT
       r.id,
       r.product_id,
       r.buyer_address,
       r.rating,
       r.title,
       r.content,
       r.helpful_count,
       r.order_id,
       r.created_at,
       pr.updated_at AS settled_at
     FROM reviews r
     LEFT JOIN products p  ON p.id  = r.product_id
     LEFT JOIN payment_records pr
            ON pr.order_id = r.order_id AND pr.status = 'settled'
    WHERE ${whereClause}
    ORDER BY ${orderClause}
    LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const data: ReviewFeedItem[] = result.rows.map((row) => ({
    id: row.id,
    productId: row.product_id,
    buyerAddress: row.buyer_address,
    rating: row.rating,
    title: row.title,
    content: row.content,
    helpfulCount: row.helpful_count,
    isVerifiedPurchase: row.settled_at !== null,
    orderCompletedAt: row.settled_at ?? null,
    createdAt: row.created_at,
  }));

  return { data, page, pageSize, total };
}

export async function voteHelpful(
  reviewId: string,
  voterIp: string | null,
  voterWallet: string | null
): Promise<{ helpfulCount: number }> {
  if (!voterIp && !voterWallet) {
    throw new Error("voter_ip or voter_wallet is required");
  }

  const db = getPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Insert the vote — unique constraints enforce deduplication atomically.
    await client.query(
      `INSERT INTO review_helpful_votes (review_id, voter_ip, voter_wallet)
       VALUES ($1, $2::inet, $3)
       ON CONFLICT DO NOTHING`,
      [reviewId, voterIp, voterWallet]
    );

    // Recount and denormalize — always from source of truth.
    const { rows } = await client.query<{ cnt: string }>(
      `UPDATE reviews
          SET helpful_count = (
            SELECT COUNT(*) FROM review_helpful_votes WHERE review_id = $1
          )
        WHERE id = $1
        RETURNING helpful_count AS cnt`,
      [reviewId]
    );

    await client.query("COMMIT");

    if (rows.length === 0) throw new Error(`Review ${reviewId} not found`);
    return { helpfulCount: parseInt(rows[0].cnt, 10) };
  } catch (err) {
    await client.query("ROLLBACK");
    log.error("voteHelpful failed", { reviewId, error: (err as Error).message });
    throw err;
  } finally {
    client.release();
  }
}
