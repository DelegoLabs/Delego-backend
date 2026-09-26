/**
 * Product catalog semantic vector search service.
 * Issue #263: cosine similarity search against products.embedding (pgvector)
 * with SQL filters for price, category, asset, and inventory status.
 *
 * Performance target: top results within 150 ms.
 *
 * The query uses the pgvector `<=>` cosine-distance operator.
 * Results are ordered by ascending distance (closest first) and then
 * converted to a similarity score in [0, 1]:  similarity = 1 - distance.
 */

import { Pool } from "pg";
import { embedText } from "./embeddings.js";
import type { SearchProductsInput, SearchProductResult } from "./types.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

// Module-level pool — lazy-initialised so tests can stub the module.
let pool: Pool | null = null;

/** Visible for testing: replace with a mock Pool. */
export function setPool(p: Pool): void {
  pool = p;
}

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env["DATABASE_URL"] ?? "postgresql://delego:delego@localhost:5432/delego",
      max: Number(process.env["DATABASE_POOL_MAX"] ?? 10),
    });
  }
  return pool;
}

/**
 * Run a semantic product search.
 *
 * Steps:
 *  1. Embed the user query via the embedding model.
 *  2. Build a parameterised pgvector cosine similarity query with optional
 *     filters (category, price, asset, merchant rating, in-stock).
 *  3. Return ranked results.
 */
export async function searchProducts(
  input: SearchProductsInput
): Promise<SearchProductResult[]> {
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  // 1. Embed query
  const embedding = await embedText(input.query);
  const embeddingLiteral = `[${embedding.join(",")}]`;

  // 2. Build dynamic WHERE clauses
  const conditions: string[] = [
    "p.status = 'active'",
    "p.in_stock = TRUE",
  ];
  const params: unknown[] = [embeddingLiteral];

  // Use a counter starting from 2 since $1 is the embedding
  let paramIndex = 2;

  if (input.category) {
    conditions.push(`p.category = $${paramIndex}`);
    params.push(input.category);
    paramIndex++;
  }

  if (input.maxPriceStroops) {
    conditions.push(`p.price_stroops <= $${paramIndex}`);
    params.push(BigInt(input.maxPriceStroops).toString());
    paramIndex++;
  }

  if (input.preferredAsset) {
    conditions.push(`p.asset_code = $${paramIndex}`);
    params.push(input.preferredAsset);
    paramIndex++;
  }

  if (input.minMerchantRating !== undefined) {
    conditions.push(`m.reputation_score >= $${paramIndex}`);
    params.push(input.minMerchantRating);
    paramIndex++;
  }

  params.push(limit);
  const limitParam = `$${paramIndex}`;

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  // 3. Execute pgvector cosine similarity query
  const sql = `
    SELECT
      p.id                      AS "productId",
      m.stellar_address         AS "merchantAddress",
      m.name                    AS "merchantName",
      p.title,
      p.description,
      p.price_stroops           AS "priceStroops",
      p.asset_code              AS "assetCode",
      p.in_stock                AS "inStock",
      1 - (p.embedding <=> $1::vector) AS "similarityScore"
    FROM products p
    JOIN merchants m ON m.id = p.merchant_id
    ${whereClause}
    ORDER BY p.embedding <=> $1::vector
    LIMIT ${limitParam}
  `;

  const result = await getPool().query<SearchProductResult>(sql, params);
  return result.rows;
}
