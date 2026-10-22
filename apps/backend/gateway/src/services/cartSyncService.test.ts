import { describe, expect, it } from "vitest";
import type { CartLineItemDTO } from "@delegolabs/types";
import {
  CartOwnershipError,
  cartLineKey,
  mergeCartLines,
  syncCart,
  toCartLineItemDTOs,
  type StoredCartLine,
} from "./cartSyncService.js";
import { InMemoryCartRepository } from "./inMemoryCartRepository.js";

const MERCHANT = "merchant-1";
const PRODUCT = "product-1";

function storedLine(overrides: Partial<StoredCartLine> = {}): StoredCartLine {
  return {
    merchantId: MERCHANT,
    productId: PRODUCT,
    skuId: null,
    quantity: 1,
    updatedAt: new Date("2026-10-01T10:00:00.000Z"),
    revision: 1,
    ...overrides,
  };
}

function clientLine(overrides: Partial<CartLineItemDTO> = {}): CartLineItemDTO {
  return {
    merchantId: MERCHANT,
    productId: PRODUCT,
    quantity: 1,
    updatedAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("cartLineKey", () => {
  it("distinguishes lines that only differ in the SKU", () => {
    const withoutSku = cartLineKey(MERCHANT, PRODUCT, null);
    const withSku = cartLineKey(MERCHANT, PRODUCT, "sku-1");
    expect(withoutSku).not.toBe(withSku);
  });

  it("treats a missing SKU and an empty SKU as the same line", () => {
    expect(cartLineKey(MERCHANT, PRODUCT, null)).toBe(cartLineKey(MERCHANT, PRODUCT, ""));
  });

  it("does not collide when an id contains the separator", () => {
    expect(cartLineKey("a b", "c", null)).not.toBe(cartLineKey("a", "b c", null));
  });
});

describe("mergeCartLines", () => {
  const now = new Date("2026-10-01T12:00:00.000Z");

  it("adds a line the client introduced", () => {
    const result = mergeCartLines({
      serverLines: [],
      clientLines: [clientLine({ quantity: 3 })],
      clientVersion: 0,
      serverVersion: 0,
      now,
    });

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({ quantity: 3, revision: 1 });
    expect(result.changedLines).toHaveLength(1);
    expect(result.serverVersion).toBe(1);
  });

  it("increments the server version on every merge", () => {
    const result = mergeCartLines({
      serverLines: [storedLine()],
      clientLines: [clientLine()],
      clientVersion: 4,
      serverVersion: 4,
      now,
    });

    expect(result.serverVersion).toBe(5);
  });

  it("keeps a line the client has not seen yet", () => {
    // The other device added the line at version 2, the client is still on 1.
    const result = mergeCartLines({
      serverLines: [storedLine({ productId: "product-new", revision: 2, quantity: 2 })],
      clientLines: [],
      clientVersion: 1,
      serverVersion: 2,
      now,
    });

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].quantity).toBe(2);
    expect(result.changedLines).toHaveLength(0);
  });

  it("removes a line the client dropped after having seen it", () => {
    const result = mergeCartLines({
      serverLines: [storedLine({ revision: 1 })],
      clientLines: [],
      clientVersion: 1,
      serverVersion: 3,
      now,
    });

    expect(result.lines[0].quantity).toBe(0);
    expect(result.lines[0].revision).toBe(4);
    expect(result.changedLines).toHaveLength(1);
  });

  it("applies the client's newer change to a line both sides hold", () => {
    const result = mergeCartLines({
      serverLines: [storedLine({ quantity: 1, updatedAt: new Date("2026-10-01T10:00:00.000Z") })],
      clientLines: [clientLine({ quantity: 5, updatedAt: "2026-10-01T11:00:00.000Z" })],
      clientVersion: 1,
      serverVersion: 2,
      now,
    });

    expect(result.lines[0].quantity).toBe(5);
    expect(result.lines[0].updatedAt.toISOString()).toBe("2026-10-01T11:00:00.000Z");
    expect(result.lines[0].revision).toBe(3);
  });

  it("keeps the server value when the client's change is older", () => {
    const result = mergeCartLines({
      serverLines: [storedLine({ quantity: 4, updatedAt: new Date("2026-10-01T11:00:00.000Z") })],
      clientLines: [clientLine({ quantity: 9, updatedAt: "2026-10-01T10:00:00.000Z" })],
      clientVersion: 1,
      serverVersion: 2,
      now,
    });

    expect(result.lines[0].quantity).toBe(4);
    expect(result.changedLines).toHaveLength(0);
  });

  it("keeps the server value when both sides changed the line at the same time", () => {
    const result = mergeCartLines({
      serverLines: [storedLine({ quantity: 4 })],
      clientLines: [clientLine({ quantity: 9 })],
      clientVersion: 1,
      serverVersion: 2,
      now,
    });

    expect(result.lines[0].quantity).toBe(4);
  });

  it("lets an up-to-date client win even when its timestamp is older", () => {
    const result = mergeCartLines({
      serverLines: [storedLine({ quantity: 4, updatedAt: new Date("2026-10-01T11:00:00.000Z") })],
      clientLines: [clientLine({ quantity: 2, updatedAt: "2026-10-01T10:00:00.000Z" })],
      clientVersion: 2,
      serverVersion: 2,
      now,
    });

    expect(result.lines[0].quantity).toBe(2);
  });

  it("accepts an explicit removal from a client that had seen the line", () => {
    const result = mergeCartLines({
      serverLines: [storedLine({ quantity: 2, revision: 1 })],
      clientLines: [clientLine({ quantity: 0, updatedAt: "2026-10-01T09:00:00.000Z" })],
      clientVersion: 2,
      serverVersion: 3,
      now,
    });

    expect(result.lines[0].quantity).toBe(0);
  });

  it("rejects an explicit removal from a stale client that never saw the line", () => {
    const result = mergeCartLines({
      serverLines: [storedLine({ quantity: 2, revision: 3 })],
      clientLines: [clientLine({ quantity: 0, updatedAt: "2026-10-01T09:00:00.000Z" })],
      clientVersion: 1,
      serverVersion: 3,
      now,
    });

    expect(result.lines[0].quantity).toBe(2);
    expect(result.changedLines).toHaveLength(0);
  });

  it("does not resurrect a removed line from a stale client", () => {
    const result = mergeCartLines({
      serverLines: [storedLine({ quantity: 0, revision: 2, updatedAt: new Date("2026-10-01T11:00:00.000Z") })],
      clientLines: [clientLine({ quantity: 2, updatedAt: "2026-10-01T10:00:00.000Z" })],
      clientVersion: 1,
      serverVersion: 2,
      now,
    });

    expect(result.lines[0].quantity).toBe(0);
  });

  it("restores a removed line when the client adds it again with a newer timestamp", () => {
    const result = mergeCartLines({
      serverLines: [storedLine({ quantity: 0, revision: 2, updatedAt: new Date("2026-10-01T10:00:00.000Z") })],
      clientLines: [clientLine({ quantity: 2, updatedAt: "2026-10-01T11:00:00.000Z" })],
      clientVersion: 1,
      serverVersion: 2,
      now,
    });

    expect(result.lines[0].quantity).toBe(2);
    expect(result.lines[0].revision).toBe(3);
  });

  it("restores a removed line when an up-to-date client holds it again", () => {
    const result = mergeCartLines({
      serverLines: [storedLine({ quantity: 0, revision: 2 })],
      clientLines: [clientLine({ quantity: 7 })],
      clientVersion: 2,
      serverVersion: 2,
      now,
    });

    expect(result.lines[0].quantity).toBe(7);
  });

  it("keeps a tombstone when both sides agree the line is gone", () => {
    const result = mergeCartLines({
      serverLines: [storedLine({ quantity: 0, revision: 2 })],
      clientLines: [clientLine({ quantity: 0 })],
      clientVersion: 1,
      serverVersion: 2,
      now,
    });

    expect(result.lines[0].quantity).toBe(0);
    expect(result.changedLines).toHaveLength(0);
  });

  it("reports a conflict only when the client version differs from the server version", () => {
    const stale = mergeCartLines({
      serverLines: [storedLine()],
      clientLines: [clientLine()],
      clientVersion: 1,
      serverVersion: 2,
      now,
    });
    const current = mergeCartLines({
      serverLines: [storedLine()],
      clientLines: [clientLine()],
      clientVersion: 2,
      serverVersion: 2,
      now,
    });

    expect(stale.conflictsResolved).toBe(true);
    expect(current.conflictsResolved).toBe(false);
  });

  it("keeps lines with the same product but a different SKU apart", () => {
    const result = mergeCartLines({
      serverLines: [storedLine({ productId: "product-1", skuId: "sku-1" })],
      clientLines: [clientLine({ productId: "product-1", skuId: "sku-2", quantity: 3 })],
      clientVersion: 1,
      serverVersion: 1,
      now,
    });

    expect(result.lines).toHaveLength(2);
  });
});

describe("toCartLineItemDTOs", () => {
  it("drops tombstones and sorts the lines", () => {
    const dtos = toCartLineItemDTOs([
      storedLine({ productId: "product-b", quantity: 2, updatedAt: new Date("2026-10-01T10:00:00.000Z") }),
      storedLine({ productId: "product-a", quantity: 0 }),
      storedLine({ productId: "product-a", quantity: 1, skuId: "sku-1" }),
    ]);

    expect(dtos).toEqual([
      {
        merchantId: MERCHANT,
        productId: "product-a",
        skuId: "sku-1",
        quantity: 1,
        updatedAt: "2026-10-01T10:00:00.000Z",
      },
      {
        merchantId: MERCHANT,
        productId: "product-b",
        quantity: 2,
        updatedAt: "2026-10-01T10:00:00.000Z",
      },
    ]);
  });
});

describe("syncCart", () => {
  it("creates the cart on the first sync and returns version 1", async () => {
    const repository = new InMemoryCartRepository();

    const response = await syncCart(
      repository,
      { cartId: "cart-1", clientVersion: 0, items: [clientLine({ quantity: 2 })] },
      "user-1",
    );

    expect(response.cartId).toBe("cart-1");
    expect(response.serverVersion).toBe(1);
    expect(response.conflictsResolved).toBe(false);
    expect(response.items).toHaveLength(1);
    expect(response.items[0].quantity).toBe(2);
  });

  it("rejects a cart that belongs to another user", async () => {
    const repository = new InMemoryCartRepository();
    await syncCart(repository, { cartId: "cart-1", clientVersion: 0, items: [] }, "user-1");

    await expect(
      syncCart(repository, { cartId: "cart-1", clientVersion: 1, items: [] }, "user-2"),
    ).rejects.toBeInstanceOf(CartOwnershipError);
  });

  it("keeps the cart version in step with the number of syncs", async () => {
    const repository = new InMemoryCartRepository();

    const first = await syncCart(
      repository,
      { cartId: "cart-1", clientVersion: 0, items: [clientLine({ quantity: 1 })] },
      "user-1",
    );
    const second = await syncCart(
      repository,
      { cartId: "cart-1", clientVersion: first.serverVersion, items: [clientLine({ quantity: 1 })] },
      "user-1",
    );

    expect(first.serverVersion).toBe(1);
    expect(second.serverVersion).toBe(2);
  });
});
