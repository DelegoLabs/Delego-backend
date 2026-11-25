import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../models/index.js", () => ({
  Merchant: {},
  Product: {},
  ProductVariant: {},
}));

vi.mock("../routes/products.js", () => ({
  fetchProductStockLevelFromDb: vi.fn(),
  getProductStockLevel: vi.fn(),
}));

vi.mock("../rateLimit/redisClient.js", () => ({
  getRedisClient: vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  })),
}));

vi.mock("../../../notifications/src/restock/queue.js", () => ({
  enqueueRestockNotification: vi.fn(),
}));

import { getProductStockLevel } from "../routes/products.js";
import { getProductStockLevelHandler, registerCatalogRoutes } from "./routes.js";

function createMockResponse(): ServerResponse & { statusCode: number; body: string } {
  const response = {
    statusCode: 200,
    body: "",
    writeHead(statusCode: number) {
      response.statusCode = statusCode;
    },
    end(body?: string) {
      response.body = body ?? "";
    },
  };
  return response as unknown as ServerResponse & { statusCode: number; body: string };
}

describe("catalog product stock level route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with product stock availability", async () => {
    vi.mocked(getProductStockLevel).mockResolvedValue({
      productId: "product-123",
      totalAvailable: 10,
      reserved: 0,
      inStock: true,
      lowStockWarning: false,
      variants: [
        { skuId: "SKU-A", available: 3, inStock: true },
      ],
    });

    const res = createMockResponse();
    await getProductStockLevelHandler(
      {} as IncomingMessage,
      res,
      { productId: "product-123" },
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      data: {
        productId: "product-123",
        totalAvailable: 10,
        reserved: 0,
        inStock: true,
        lowStockWarning: false,
        variants: [
          { skuId: "SKU-A", available: 3, inStock: true },
        ],
      },
      error: null,
    });
  });

  it("returns 404 when the product is unknown", async () => {
    vi.mocked(getProductStockLevel).mockRejectedValue(
      new Error("Product product-404 not found"),
    );

    const res = createMockResponse();
    await getProductStockLevelHandler(
      {} as IncomingMessage,
      res,
      { productId: "product-404" },
    );

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.data).toBeNull();
    expect(body.error).toEqual({
      code: "NOT_FOUND",
      message: "Product not found",
    });
  });

  it("registers the stock-level route", () => {
    const routes = registerCatalogRoutes();
    expect(routes.some((registered) =>
      registered.method === "GET"
      && registered.pattern.test("/api/v1/products/product-123/stock-level")
      && registered.paramNames.includes("productId")
    )).toBe(true);
  });
});
