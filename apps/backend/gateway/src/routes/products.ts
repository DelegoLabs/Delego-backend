import type { IncomingMessage, ServerResponse } from "node:http";
import type { Route } from "@delegolabs/utils";
import { route, createLogger } from "@delegolabs/utils";
import { getRedisClient } from "../rateLimit/redisClient.js";
import { badRequest, notFound, sendApiError } from "../errors.js";
import { Product, ProductVariant } from "../models/index.js";

const log = createLogger("gateway:products", process.env.LOG_LEVEL ?? "info");

export interface StockLevelVariantResponse {
  skuId: string;
  available: number;
  inStock: boolean;
}

export interface StockLevelResponse {
  productId: string;
  totalAvailable: number;
  reserved: number;
  inStock: boolean;
  lowStockWarning: boolean;
  variants?: StockLevelVariantResponse[];
}

export interface ProductStockLevelDependencies {
  redis?: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
    del(key: string): Promise<number>;
  };
  lookupProductStock?: (productId: string) => Promise<StockLevelResponse>;
  lockWaitMs?: number;
  ttlSeconds?: number;
  jitterSeconds?: number;
  random?: () => number;
}

const DEFAULT_STOCK_CACHE_TTL = 30;
const DEFAULT_STOCK_CACHE_JITTER = 10;
const DEFAULT_LOCK_TTL_MS = 1500;
const inFlightStockLoads = new Map<string, Promise<StockLevelResponse>>();

export function getStockCacheTtlSeconds(
  baseSeconds = DEFAULT_STOCK_CACHE_TTL,
  jitterSeconds = DEFAULT_STOCK_CACHE_JITTER,
  randomFn: () => number = Math.random,
): number {
  return baseSeconds + Math.floor(randomFn() * jitterSeconds);
}

function parseCacheValue<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function fetchProductStockLevelFromDb(productId: string): Promise<StockLevelResponse> {
  const product = await Product.findByPk(productId, {
    include: [{ model: ProductVariant, as: "variants" }],
  });

  if (!product) {
    throw new Error(`Product ${productId} not found`);
  }

  const variants = Array.isArray((product as any).variants) ? (product as any).variants : [];
  const totalAvailable = Number(product.stockQuantity ?? 0) + variants.reduce(
    (sum: number, variant: ProductVariant) => sum + Math.max(0, Number(variant.stockCount ?? 0)),
    0,
  );

  const variantResponse = variants.map((variant: ProductVariant) => {
    const available = Math.max(0, Number(variant.stockCount ?? 0));
    return {
      skuId: String(variant.sku),
      available,
      inStock: available > 0,
    };
  });

  return {
    productId,
    totalAvailable,
    reserved: 0,
    inStock: totalAvailable > 0,
    lowStockWarning: totalAvailable <= 5,
    variants: variantResponse.length > 0 ? variantResponse : undefined,
  };
}

export async function getProductStockLevel(
  productId: string,
  deps: ProductStockLevelDependencies = {},
): Promise<StockLevelResponse> {
  const redis = deps.redis ?? getRedisClient();
  const lookupProductStock = deps.lookupProductStock ?? fetchProductStockLevelFromDb;
  const lockWaitMs = deps.lockWaitMs ?? 25;
  const cacheKey = `stock:${productId}`;
  const lockKey = `${cacheKey}:lock`;

  const cachedValue = parseCacheValue<StockLevelResponse>(await redis.get(cacheKey));
  if (cachedValue) {
    return cachedValue;
  }

  const existingLoad = inFlightStockLoads.get(productId);
  if (existingLoad) {
    return existingLoad;
  }

  const loadPromise = (async () => {
    const cachedBeforeLoad = parseCacheValue<StockLevelResponse>(await redis.get(cacheKey));
    if (cachedBeforeLoad) {
      return cachedBeforeLoad;
    }

    const lockAcquiredResult = await redis.set(lockKey, "1", "PX", DEFAULT_LOCK_TTL_MS, "NX");
    const lockAcquired = lockAcquiredResult === "OK" || lockAcquiredResult === 1 || lockAcquiredResult === true;

    if (lockAcquired) {
      try {
        const freshValue = await lookupProductStock(productId);
        await redis.set(
          cacheKey,
          JSON.stringify(freshValue),
          "EX",
          getStockCacheTtlSeconds(
            deps.ttlSeconds ?? DEFAULT_STOCK_CACHE_TTL,
            deps.jitterSeconds ?? DEFAULT_STOCK_CACHE_JITTER,
            deps.random ?? Math.random,
          ),
        );
        return freshValue;
      } finally {
        await redis.del(lockKey);
      }
    }

    for (let attempt = 0; attempt < 25; attempt += 1) {
      const cachedRetry = parseCacheValue<StockLevelResponse>(await redis.get(cacheKey));
      if (cachedRetry) {
        return cachedRetry;
      }
      await new Promise((resolve) => setTimeout(resolve, lockWaitMs));
    }

    const finalCachedValue = parseCacheValue<StockLevelResponse>(await redis.get(cacheKey));
    if (finalCachedValue) {
      return finalCachedValue;
    }

    const fallbackValue = await lookupProductStock(productId);
    await redis.set(
      cacheKey,
      JSON.stringify(fallbackValue),
      "EX",
      getStockCacheTtlSeconds(
        deps.ttlSeconds ?? DEFAULT_STOCK_CACHE_TTL,
        deps.jitterSeconds ?? DEFAULT_STOCK_CACHE_JITTER,
        deps.random ?? Math.random,
      ),
    );
    return fallbackValue;
  })();

  inFlightStockLoads.set(productId, loadPromise);

  try {
    return await loadPromise;
  } finally {
    inFlightStockLoads.delete(productId);
  }
}

export async function getProductStockLevelHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  const productId = params.productId;
  if (!productId) {
    badRequest(res, "productId path parameter is required", req);
    return;
  }

  try {
    const stockLevel = await getProductStockLevel(productId, {
      redis: getRedisClient(),
      lookupProductStock: fetchProductStockLevelFromDb,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: stockLevel, error: null }));
  } catch (err: any) {
    if (err instanceof Error && err.message.includes("not found")) {
      notFound(res, "Product not found", req);
      return;
    }

    log.error("Failed to fetch product stock level", {
      error: err instanceof Error ? err.message : String(err),
      productId,
    });
    sendApiError(res, 500, "PRODUCT_STOCK_FETCH_FAILED",
      err instanceof Error ? err.message : "Failed to fetch product stock level", req);
  }
}

export function registerProductRoutes(): Route[] {
  return [
    route("GET", "/api/v1/products/:productId/stock-level", getProductStockLevelHandler),
  ];
}
