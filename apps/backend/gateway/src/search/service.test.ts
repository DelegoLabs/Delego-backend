/**
 * Unit tests for the semantic product search service.
 * Issue #263: verifies query embedding, SQL filter application, and result mapping.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Pool } from "pg";

// ---------------------------------------------------------------------------
// Module-level mocks must be hoisted above imports that use the mocked modules.
// ---------------------------------------------------------------------------

vi.mock("./embeddings.js", () => ({
  embedText: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
}));

import { searchProducts, setPool } from "./service.js";
import { embedText } from "./embeddings.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PRODUCT_ROW = {
  productId: "prod-1",
  merchantAddress: "GXYZ",
  merchantName: "Acme",
  title: "Blue Sneakers",
  description: "Comfortable running shoes",
  priceStroops: "50000000",
  assetCode: "USDC",
  inStock: true,
  similarityScore: 0.92,
};

function makePoolMock(rows: unknown[] = [PRODUCT_ROW]): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("searchProducts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls embedText with the user query", async () => {
    const pool = makePoolMock();
    setPool(pool);

    await searchProducts({ query: "blue running shoes" });

    expect(embedText).toHaveBeenCalledWith("blue running shoes");
  });

  it("returns mapped product results", async () => {
    const pool = makePoolMock();
    setPool(pool);

    const results = await searchProducts({ query: "sneakers" });

    expect(results).toHaveLength(1);
    expect(results[0].productId).toBe("prod-1");
    expect(results[0].similarityScore).toBe(0.92);
    expect(results[0].inStock).toBe(true);
  });

  it("applies category filter in SQL params", async () => {
    const pool = makePoolMock();
    setPool(pool);

    await searchProducts({ query: "shoes", category: "footwear" });

    const queryCall = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
    const params = queryCall[1] as unknown[];
    expect(params).toContain("footwear");
    expect(queryCall[0]).toContain("p.category =");
  });

  it("applies maxPriceStroops filter in SQL params", async () => {
    const pool = makePoolMock();
    setPool(pool);

    await searchProducts({ query: "shoes", maxPriceStroops: "1000000" });

    const params = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(params).toContain("1000000");
  });

  it("applies limit (defaults to 10)", async () => {
    const pool = makePoolMock([]);
    setPool(pool);

    await searchProducts({ query: "hat" });

    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("LIMIT");
    const params = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(params).toContain(10);
  });

  it("caps limit at 50", async () => {
    const pool = makePoolMock([]);
    setPool(pool);

    await searchProducts({ query: "hat", limit: 200 });

    const params = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(params).toContain(50);
  });

  it("returns empty array when no products match", async () => {
    const pool = makePoolMock([]);
    setPool(pool);

    const results = await searchProducts({ query: "unobtanium widget" });
    expect(results).toHaveLength(0);
  });

  it("propagates errors from embedText", async () => {
    vi.mocked(embedText).mockRejectedValueOnce(new Error("API key not set"));
    const pool = makePoolMock();
    setPool(pool);

    await expect(searchProducts({ query: "shoes" })).rejects.toThrow("API key not set");
  });

  it("excludes out-of-stock products via SQL WHERE clause", async () => {
    const pool = makePoolMock();
    setPool(pool);

    await searchProducts({ query: "shirt" });

    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("p.in_stock = TRUE");
  });

  it("excludes unlisted products via SQL WHERE clause", async () => {
    const pool = makePoolMock();
    setPool(pool);

    await searchProducts({ query: "shirt" });

    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("p.status = 'active'");
  });
});
