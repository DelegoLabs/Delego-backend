/**
 * Storefront API routes (Issue #112).
 *
 * High-throughput public REST API allowing buyers and agents to browse
 * a merchant's inventory with:
 * - Base64 cursor encoding for deterministic pagination on (created_at, id)
 * - Redis caching (60s TTL) with cache invalidation on product updates
 */

import type { Route, RouteHandler } from "@delegolabs/utils";
import { json, createLogger, route } from "@delegolabs/utils";
import type {
  Product,
  StorefrontQueryParams,
  PaginatedProductsResponse,
  ProductSortOption,
} from "@delegolabs/types";
import { Redis } from "ioredis";
import { QueryTypes } from "sequelize";
import { sequelize } from "../src/db.js";
import { encodeCursor, decodeCursor } from "../src/base64Cursor.js";

const log = createLogger("gateway:storefront", process.env.LOG_LEVEL ?? "info");

// Redis client singleton
let redisClient: Redis | null = null;

/**
 * Get or initialize Redis client.
 */
export function getRedisClient(): Redis {
  if (!redisClient) {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    redisClient = new Redis(redisUrl);
    redisClient.on("error", (err: Error) => log.error("Redis client error", { error: err.message }));
    redisClient.on("connect", () => log.info("Redis client connected"));
  }
  return redisClient;
}

/**
 * Cache key for merchant products list.
 */
export function getProductsCacheKey(merchantId: string, params: StorefrontQueryParams): string {
  const { cursor, limit = 20, category, minPrice, maxPrice, sort = "newest" } = params;
  const paramsHash = [
    cursor ? `cursor=${cursor}` : "",
    `limit=${limit}`,
    category ? `category=${category}` : "",
    minPrice ? `minPrice=${minPrice}` : "",
    maxPrice ? `maxPrice=${maxPrice}` : "",
    `sort=${sort}`,
  ]
    .filter(Boolean)
    .join("&");
  return `storefront:merchant:${merchantId}:products:${paramsHash}`;
}

/**
 * Cache key for individual product.
 */
export function getProductCacheKey(merchantId: string, productId: string): string {
  return `storefront:merchant:${merchantId}:product:${productId}`;
}

/**
 * Invalidate product cache for a merchant.
 */
export async function invalidateProductCache(merchantId: string, productId?: string): Promise<void> {
  const client = getRedisClient();
  if (productId) {
    // Invalidate specific product
    await client.del(getProductCacheKey(merchantId, productId));
  }
  // Invalidate all product list caches for this merchant
  // This could be optimized with a dedicated set key
  await client.del(`storefront:merchant:${merchantId}:products:*`);
}

/**
 * Encode pagination cursor as Base64 from (created_at, id) tuple.
 * Format: base64("created_at|id")
 */
export { encodeCursor };

/**
 * Decode Base64 cursor to (created_at, id) tuple.
 */
export { decodeCursor };

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const VALID_SORTS: ReadonlySet<string> = new Set(["newest", "price_asc", "price_desc"]);

/** Raised when storefront query parameters (including the cursor) are invalid. */
export class StorefrontValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StorefrontValidationError";
  }
}

export interface NormalizedStorefrontQuery extends StorefrontQueryParams {
  limit: number;
  sort: ProductSortOption;
}

interface CursorTuple {
  createdAt: Date;
  id: string;
}

interface ProductRow {
  id: string;
  merchantId: string;
  name: string;
  description: string | null;
  priceStroops: string | number | bigint;
  currency: string;
  category: string | null;
  imageUrl: string | null;
  stockQuantity: number | string;
  attributes: Record<string, unknown> | null;
  createdAt: string | Date;
  updatedAt: string | Date | null;
}

interface CountRow {
  totalCount: number | string;
  cursorExists?: number | string;
}

function parseCursor(cursor: string): CursorTuple {
  const decoded = decodeCursor(cursor);
  if (!decoded) {
    throw new StorefrontValidationError("INVALID_CURSOR", "Invalid cursor format");
  }
  const timestamp = Date.parse(decoded.createdAt);
  if (!Number.isFinite(timestamp)) {
    throw new StorefrontValidationError("INVALID_CURSOR", "Invalid cursor timestamp");
  }
  return { createdAt: new Date(timestamp), id: decoded.id };
}

function parseCategory(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") {
    throw new StorefrontValidationError("INVALID_CATEGORY", "category must be a string");
  }
  return raw.trim() || undefined;
}

function parsePriceFilter(raw: unknown, code: string, field: string): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || !/^\d{1,19}$/.test(raw)) {
    throw new StorefrontValidationError(code, `${field} must be a non-negative integer`);
  }
  return raw;
}

/** Validate and apply defaults to storefront query parameters. */
export function normalizeStorefrontQuery(
  merchantId: string,
  params: StorefrontQueryParams,
): NormalizedStorefrontQuery {
  if (typeof merchantId !== "string" || merchantId.trim() === "") {
    throw new StorefrontValidationError("INVALID_MERCHANT_ID", "merchantId is required");
  }
  if (!params || typeof params !== "object") {
    throw new StorefrontValidationError("INVALID_QUERY", "Query parameters are required");
  }

  const limit = params.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new StorefrontValidationError("INVALID_LIMIT", "limit must be between 1 and 50");
  }

  const sort = params.sort ?? "newest";
  if (!VALID_SORTS.has(sort)) {
    throw new StorefrontValidationError("INVALID_SORT", "sort must be newest, price_asc, or price_desc");
  }

  const category = parseCategory(params.category);
  const minPrice = parsePriceFilter(params.minPrice, "INVALID_MIN_PRICE", "minPrice");
  const maxPrice = parsePriceFilter(params.maxPrice, "INVALID_MAX_PRICE", "maxPrice");
  if (minPrice !== undefined && maxPrice !== undefined && BigInt(minPrice) > BigInt(maxPrice)) {
    throw new StorefrontValidationError("INVALID_PRICE_RANGE", "minPrice must not exceed maxPrice");
  }

  if (params.cursor !== undefined && params.cursor !== "") {
    parseCursor(params.cursor);
  }

  return {
    cursor: params.cursor || undefined,
    limit,
    category,
    minPrice,
    maxPrice,
    sort: sort as ProductSortOption,
  };
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapProductRow(row: ProductRow): Product {
  return {
    id: String(row.id),
    merchantId: String(row.merchantId),
    name: String(row.name),
    description: row.description ?? undefined,
    priceStroops: String(row.priceStroops),
    currency: String(row.currency),
    category: row.category ?? undefined,
    imageUrl: row.imageUrl ?? undefined,
    stockQuantity: Number(row.stockQuantity),
    attributes: row.attributes ?? undefined,
    createdAt: toIso(row.createdAt),
    updatedAt: row.updatedAt == null ? undefined : toIso(row.updatedAt),
  };
}

/**
 * Fetch a page of listed products for a merchant.
 *
 * Cursors remain (created_at, id) tuples. For price sorts the cursor row's
 * price is resolved from the database so the keyset predicate matches the
 * full ORDER BY tuple and never skips or repeats rows at price boundaries.
 */
export async function fetchProducts(
  merchantId: string,
  params: StorefrontQueryParams,
): Promise<PaginatedProductsResponse> {
  const query = normalizeStorefrontQuery(merchantId, params);
  const cursor = query.cursor ? parseCursor(query.cursor) : null;
  const usesCursorPrice = cursor !== null && query.sort !== "newest";

  const baseConditions = ["p.merchant_id = :merchantId", "p.is_listed = TRUE"];
  const replacements: Record<string, unknown> = { merchantId };

  if (query.category !== undefined) {
    baseConditions.push("p.category = :category");
    replacements.category = query.category;
  }
  if (query.minPrice !== undefined) {
    baseConditions.push("p.price_stroops >= :minPrice::bigint");
    replacements.minPrice = query.minPrice;
  }
  if (query.maxPrice !== undefined) {
    baseConditions.push("p.price_stroops <= :maxPrice::bigint");
    replacements.maxPrice = query.maxPrice;
  }
  if (cursor) {
    replacements.cursorCreatedAt = cursor.createdAt.toISOString();
    replacements.cursorId = cursor.id;
  }

  const pageConditions = [...baseConditions];
  if (cursor) {
    if (query.sort === "newest") {
      pageConditions.push("(p.created_at, p.id::text) < (:cursorCreatedAt::timestamptz, :cursorId)");
    } else {
      // Both price sorts break ties with the newest (created_at, id) tuple first.
      const priceComparison = query.sort === "price_asc" ? ">" : "<";
      pageConditions.push(`(
        p.price_stroops ${priceComparison} cp.price_stroops
        OR (p.price_stroops = cp.price_stroops AND (p.created_at, p.id::text) < (:cursorCreatedAt::timestamptz, :cursorId))
      )`);
    }
  }

  const cursorCte = usesCursorPrice
    ? `WITH cursor_product AS (
         SELECT price_stroops
         FROM products
         WHERE merchant_id = :merchantId AND id = :cursorId
       )`
    : "";
  const fromClause = usesCursorPrice
    ? "FROM products p CROSS JOIN cursor_product cp"
    : "FROM products p";
  const orderBy =
    query.sort === "price_asc"
      ? "ORDER BY p.price_stroops ASC, p.created_at DESC, p.id::text DESC"
      : query.sort === "price_desc"
        ? "ORDER BY p.price_stroops DESC, p.created_at DESC, p.id::text DESC"
        : "ORDER BY p.created_at DESC, p.id::text DESC";

  const pageSize = query.limit + 1;
  replacements.pageSize = pageSize;

  const rows = await sequelize.query<ProductRow>(
    `${cursorCte}
     SELECT p.id,
            p.merchant_id               AS "merchantId",
            p.title                     AS "name",
            p.description,
            p.price_stroops             AS "priceStroops",
            p.asset_code                AS "currency",
            p.category,
            p.image_url                 AS "imageUrl",
            p.stock_quantity            AS "stockQuantity",
            p.metadata                  AS "attributes",
            p.created_at                AS "createdAt",
            p.updated_at                AS "updatedAt"
     ${fromClause}
     WHERE ${pageConditions.join(" AND ")}
     ${orderBy}
     LIMIT :pageSize`,
    { replacements, type: QueryTypes.SELECT },
  );

  const countReplacements = { ...replacements };
  delete countReplacements.pageSize;
  const countColumns = cursor
    ? `COUNT(*)::int AS "totalCount",
       (SELECT COUNT(*) FROM products
          WHERE merchant_id = :merchantId AND id = :cursorId)::int AS "cursorExists"`
    : `COUNT(*)::int AS "totalCount"`;
  const countRows = await sequelize.query<CountRow>(
    `SELECT ${countColumns}
     FROM products p
     WHERE ${baseConditions.join(" AND ")}`,
    { replacements: countReplacements, type: QueryTypes.SELECT },
  );
  const countRow = countRows[0];
  if (cursor && countRow?.cursorExists !== undefined && Number(countRow.cursorExists) === 0) {
    throw new StorefrontValidationError("INVALID_CURSOR", "Cursor does not belong to this merchant");
  }

  const productRows = Array.isArray(rows) ? rows : [];
  const hasMore = productRows.length > query.limit;
  const pageRows = hasMore ? productRows.slice(0, query.limit) : productRows;
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && lastRow
    ? encodeCursor(toIso(lastRow.createdAt), String(lastRow.id))
    : null;

  return {
    items: pageRows.map(mapProductRow),
    nextCursor,
    totalCount: Number(countRow?.totalCount ?? 0),
  };
}

/**
 * Storefront products list handler.
 *
 * GET /api/v1/merchants/:merchantId/products
 *
 * Query params:
 * - cursor: Base64-encoded (created_at, id) for pagination
 * - limit: 1-50, default 20
 * - category: Filter by category
 * - minPrice: Minimum price filter
 * - maxPrice: Maximum price filter
 * - sort: "price_asc" | "price_desc" | "newest"
 */
export const listProductsHandler: RouteHandler = async (req, res, params) => {
  const merchantId = params.merchantId;
  if (!merchantId) {
    json(res, 400, {
      data: null,
      error: { code: "MISSING_MERCHANT_ID", message: "merchantId path parameter is required" },
    });
    return;
  }

  const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
  const rawLimit = url.searchParams.get("limit");
  const query: StorefrontQueryParams = {
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: rawLimit === null ? undefined : Number(rawLimit),
    category: url.searchParams.get("category") ?? undefined,
    minPrice: url.searchParams.get("minPrice") ?? undefined,
    maxPrice: url.searchParams.get("maxPrice") ?? undefined,
    sort: (url.searchParams.get("sort") ?? undefined) as ProductSortOption | undefined,
  };

  let normalized: NormalizedStorefrontQuery;
  try {
    normalized = normalizeStorefrontQuery(merchantId, query);
  } catch (err) {
    json(res, 400, {
      data: null,
      error: {
        code: err instanceof StorefrontValidationError ? err.code : "INVALID_QUERY",
        message: err instanceof Error ? err.message : "Invalid query parameters",
      },
    });
    return;
  }

  const client = getRedisClient();
  const cacheKey = getProductsCacheKey(merchantId, normalized);
  const cacheTTL = 60; // 60 seconds

  try {
    // Try to get from cache
    const cached = await client.get(cacheKey);
    if (cached) {
      log.debug("Cache hit for products list", { merchantId, cacheKey });
      const response: PaginatedProductsResponse = JSON.parse(cached);
      json(res, 200, { data: response, error: null });
      return;
    }

    log.debug("Cache miss for products list", { merchantId, cacheKey });

    // Fetch from database
    const result = await fetchProducts(merchantId, normalized);

    // Cache the result
    await client.setex(cacheKey, cacheTTL, JSON.stringify(result));

    json(res, 200, { data: result, error: null });
  } catch (err) {
    if (err instanceof StorefrontValidationError) {
      json(res, 400, {
        data: null,
        error: { code: err.code, message: err.message },
      });
      return;
    }
    log.error("Failed to fetch products", {
      merchantId,
      error: err instanceof Error ? err.message : String(err),
    });
    json(res, 500, {
      data: null,
      error: { code: "PRODUCTS_FETCH_FAILED", message: err instanceof Error ? err.message : "Failed to fetch products" },
    });
  }
};

/**
 * Get single product handler (for cache invalidation on updates).
 *
 * GET /api/v1/merchants/:merchantId/products/:productId
 */
export const getProductHandler: RouteHandler = async (_req, res, params) => {
  const { merchantId, productId } = params;

  if (!merchantId || !productId) {
    json(res, 400, {
      data: null,
      error: { code: "MISSING_PARAMETERS", message: "merchantId and productId are required" },
    });
    return;
  }

  const client = getRedisClient();
  const cacheKey = getProductCacheKey(merchantId, productId);

  try {
    // Try to get from cache
    const cached = await client.get(cacheKey);
    if (cached) {
      const product: Product = JSON.parse(cached);
      json(res, 200, { data: product, error: null });
      return;
    }

    // Fetch from database (stub)
    const product: Product | null = null; // Replace with actual fetch

    if (!product) {
      json(res, 404, {
        data: null,
        error: { code: "PRODUCT_NOT_FOUND", message: "Product not found" },
      });
      return;
    }

    // Cache the result
    await client.setex(cacheKey, 60, JSON.stringify(product));

    json(res, 200, { data: product, error: null });
  } catch (err) {
    log.error("Failed to fetch product", {
      merchantId,
      productId,
      error: err instanceof Error ? err.message : String(err),
    });
    json(res, 500, {
      data: null,
      error: { code: "PRODUCT_FETCH_FAILED", message: err instanceof Error ? err.message : "Failed to fetch product" },
    });
  }
};

/**
 * Register storefront routes.
 */
export function registerStorefrontRoutes(): Route[] {
  return [
    route("GET", "/api/v1/merchants/:merchantId/products", listProductsHandler),
    route("GET", "/api/v1/merchants/:merchantId/products/:productId", getProductHandler),
  ];
}

