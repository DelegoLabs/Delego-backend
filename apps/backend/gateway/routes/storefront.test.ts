import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductSortOption, StorefrontQueryParams } from "@delegolabs/types";
import {
  encodeCursor,
  fetchProducts,
  listProductsHandler,
  StorefrontValidationError,
} from "./storefront.js";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../src/db.js", () => ({ sequelize: { query } }));

type MockResponse = ServerResponse & {
  statusCode: number;
  body: string;
  headersSent: boolean;
  setHeader(name: string, value: string | number): void;
  writeHead(status: number): void;
  end(body?: string): void;
};

function createResponse(): MockResponse {
  return {
    statusCode: 0,
    body: "",
    headersSent: false,
    setHeader() {},
    writeHead(status: number) {
      this.statusCode = status;
      this.headersSent = true;
    },
    end(body?: string) {
      if (body) this.body = body;
    },
  } as MockResponse;
}

function createRequest(url: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.url = url;
  req.headers = { host: "localhost" };
  return req;
}

function productRow(id: string, createdAt: string, priceStroops: string) {
  return {
    id,
    merchantId: "merchant-1",
    name: `Product ${id}`,
    description: null,
    priceStroops,
    currency: "USDC",
    category: "tools",
    imageUrl: null,
    stockQuantity: 5,
    attributes: { color: "red" },
    createdAt,
    updatedAt: createdAt,
  };
}

const FIRST = "2026-01-03T00:00:00.000Z";
const SECOND = "2026-01-02T00:00:00.000Z";
const THIRD = "2026-01-01T00:00:00.000Z";

describe("storefront.fetchProducts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies filters, trims the page, and builds a (created_at, id) cursor", async () => {
    query
      .mockResolvedValueOnce([
        productRow("p1", FIRST, "100"),
        productRow("p2", SECOND, "200"),
        productRow("p3", THIRD, "300"),
      ])
      .mockResolvedValueOnce([{ totalCount: 42 }]);

    const result = await fetchProducts("merchant-1", {
      limit: 2,
      category: "tools",
      minPrice: "100",
      maxPrice: "500",
      sort: "newest",
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      id: "p1",
      merchantId: "merchant-1",
      name: "Product p1",
      priceStroops: "100",
      currency: "USDC",
      category: "tools",
      stockQuantity: 5,
      attributes: { color: "red" },
      createdAt: FIRST,
    });
    expect(result.nextCursor).toBe(encodeCursor(SECOND, "p2"));
    expect(result.totalCount).toBe(42);

    const [pageSql, pageOptions] = query.mock.calls[0];
    expect(pageSql).toContain("p.category = :category");
    expect(pageSql).toContain("p.price_stroops >= :minPrice::bigint");
    expect(pageSql).toContain("p.price_stroops <= :maxPrice::bigint");
    expect(pageSql).toContain("ORDER BY p.created_at DESC, p.id::text DESC");
    expect(pageSql).toContain("LIMIT :pageSize");
    expect(pageOptions.replacements).toMatchObject({
      merchantId: "merchant-1",
      category: "tools",
      minPrice: "100",
      maxPrice: "500",
      pageSize: 3,
    });

    const [countSql, countOptions] = query.mock.calls[1];
    expect(countSql).toContain("COUNT(*)::int AS \"totalCount\"");
    expect(countOptions.replacements).not.toHaveProperty("pageSize");
  });

  it.each([
    ["price_asc", ">"],
    ["price_desc", "<"],
  ] as Array<[ProductSortOption, string]>)(
    "uses a price keyset predicate for %s",
    async (sort, comparison) => {
      const cursor = encodeCursor(SECOND, "p2");
      query
        .mockResolvedValueOnce([productRow("p3", THIRD, "300")])
        .mockResolvedValueOnce([{ totalCount: 5, cursorExists: 1 }]);

      await fetchProducts("merchant-1", { cursor, limit: 10, sort });

      const [sql, options] = query.mock.calls[0];
      expect(sql).toContain("WITH cursor_product AS");
      expect(sql).toContain("CROSS JOIN cursor_product cp");
      expect(sql).toContain(`p.price_stroops ${comparison} cp.price_stroops`);
      expect(sql).toContain("(p.created_at, p.id::text) < (:cursorCreatedAt::timestamptz, :cursorId)");
      expect(sql).toContain(
        `ORDER BY p.price_stroops ${sort === "price_asc" ? "ASC" : "DESC"}, p.created_at DESC, p.id::text DESC`,
      );
      expect(options.replacements).toMatchObject({
        cursorCreatedAt: SECOND,
        cursorId: "p2",
      });
    },
  );

  it("rejects malformed cursors before querying", async () => {
    await expect(
      fetchProducts("merchant-1", { cursor: "not-a-base64-cursor" }),
    ).rejects.toMatchObject({ name: "StorefrontValidationError", code: "INVALID_CURSOR" });
    await expect(
      fetchProducts("merchant-1", { cursor: encodeCursor("not-a-date", "p1") }),
    ).rejects.toBeInstanceOf(StorefrontValidationError);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects a cursor that does not belong to the merchant", async () => {
    query
      .mockResolvedValueOnce([productRow("p1", FIRST, "100")])
      .mockResolvedValueOnce([{ totalCount: 1, cursorExists: 0 }]);

    await expect(
      fetchProducts("merchant-1", { cursor: encodeCursor(SECOND, "p2") }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it.each([
    [{ limit: 0 }, "INVALID_LIMIT"],
    [{ limit: 1.5 }, "INVALID_LIMIT"],
    [{ sort: "weekly" as never }, "INVALID_SORT"],
    [{ minPrice: "10.5" }, "INVALID_MIN_PRICE"],
    [{ maxPrice: "-1" }, "INVALID_MAX_PRICE"],
    [{ minPrice: "20", maxPrice: "10" }, "INVALID_PRICE_RANGE"],
  ] as Array<[StorefrontQueryParams, string]>)(
    "rejects invalid query parameters %o",
    async (params, code) => {
      await expect(fetchProducts("merchant-1", params)).rejects.toMatchObject({ code });
      expect(query).not.toHaveBeenCalled();
    },
  );
});

describe("listProductsHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 for an invalid cursor without querying the database", async () => {
    const res = createResponse();

    await listProductsHandler(
      createRequest("/api/v1/merchants/merchant-1/products?cursor=invalid"),
      res,
      { merchantId: "merchant-1" },
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("INVALID_CURSOR");
    expect(query).not.toHaveBeenCalled();
  });
});
