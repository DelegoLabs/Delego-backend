/**
 * Cart sync integration coverage (Issue #574).
 *
 * Drives the real route handler, the real service layer and the real merge
 * strategy — only the storage is swapped for the in-memory repository, so the
 * suite runs without a database while still exercising the full request path
 * (validation → merge → response shaping).
 *
 * The scenarios reproduce the bug this endpoint exists for: a buyer edits the
 * same cart on a phone and on a laptop, and neither device may silently
 * destroy what the other one added.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CartSyncRequest } from "@delegolabs/types";
import { syncCartHandler } from "./cart.js";
import { InMemoryCartRepository } from "../services/inMemoryCartRepository.js";

const { extractAuthMock } = vi.hoisted(() => ({
  extractAuthMock: vi.fn(),
}));

vi.mock("../../middleware/auth.js", () => ({
  extractAuth: (req: IncomingMessage) => extractAuthMock(req),
  getAuthenticatedUserContext: (req: IncomingMessage) => undefined,
}));

// The payload travels with the request so that two devices can sync at the
// same time without stepping on each other's body.
vi.mock("../request.js", () => ({
  readJsonBody: vi.fn(async (req: IncomingMessage) => (req as any).payload),
  InvalidJsonError: class InvalidJsonError extends Error {},
  BodyTooLargeError: class BodyTooLargeError extends Error {},
}));

const { repository } = vi.hoisted(() => ({
  repository: { current: null as unknown },
}));

vi.mock("../services/cartRepository.js", () => ({
  sequelizeCartRepository: {
    runInTransaction: (fn: any) => (repository.current as any).runInTransaction(fn),
  },
}));

type MockResponse = ServerResponse & {
  statusCode: number;
  body: string;
  headersSent: boolean;
  headers: Record<string, string>;
  setHeader(name: string, value: string | number): void;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
};

function createResponse(): MockResponse {
  return {
    statusCode: 0,
    body: "",
    headersSent: false,
    headers: {},
    setHeader(name: string, value: string | number) {
      this.headers[name.toLowerCase()] = String(value);
    },
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      this.headersSent = true;
      if (headers) {
        Object.assign(this.headers, headers);
      }
    },
    end(body?: string) {
      if (body) this.body = body;
    },
  } as MockResponse;
}

function createRequest(payload: CartSyncRequest, userId = "user-1"): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.headers = { authorization: "Bearer valid-token" };
  (req as any).payload = payload;
  extractAuthMock.mockReturnValue({ userId, token: "valid-token" });
  return req;
}

async function sync(payload: CartSyncRequest, userId = "user-1") {
  const res = createResponse();
  await syncCartHandler(createRequest(payload, userId), res);
  const json = res.body ? JSON.parse(res.body) : null;
  return { statusCode: res.statusCode, body: json, data: json?.data };
}

const MERCHANT = "merchant-1";
const T0 = "2026-10-01T10:00:00.000Z";
const T1 = "2026-10-01T10:05:00.000Z";
const T2 = "2026-10-01T10:10:00.000Z";

describe("cart sync — two devices", () => {
  let store: InMemoryCartRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new InMemoryCartRepository();
    repository.current = store;
    extractAuthMock.mockReturnValue({ userId: "user-1", token: "valid-token" });
  });

  it("creates the cart on the first sync", async () => {
    const result = await sync({
      cartId: "cart-1",
      clientVersion: 0,
      items: [{ merchantId: MERCHANT, productId: "product-1", quantity: 1, updatedAt: T0 }],
    });

    expect(result.statusCode).toBe(200);
    expect(result.data.serverVersion).toBe(1);
    expect(result.data.conflictsResolved).toBe(false);
    expect(result.data.items).toHaveLength(1);
  });

  it("keeps a line added by another device when an outdated device syncs", async () => {
    // Both devices start from an empty cart.
    const initial = await sync({
      cartId: "cart-1",
      clientVersion: 0,
      items: [{ merchantId: MERCHANT, productId: "product-1", quantity: 1, updatedAt: T0 }],
    });
    const baseVersion = initial.data.serverVersion;

    // The phone adds a second product and syncs.
    const phone = await sync({
      cartId: "cart-1",
      clientVersion: baseVersion,
      items: [
        { merchantId: MERCHANT, productId: "product-1", quantity: 1, updatedAt: T0 },
        { merchantId: MERCHANT, productId: "product-2", quantity: 3, updatedAt: T1 },
      ],
    });
    expect(phone.data.items).toHaveLength(2);

    // The laptop is still on the old version and syncs its own view.
    const laptop = await sync({
      cartId: "cart-1",
      clientVersion: baseVersion,
      items: [{ merchantId: MERCHANT, productId: "product-1", quantity: 2, updatedAt: T2 }],
    });

    expect(laptop.statusCode).toBe(200);
    expect(laptop.data.conflictsResolved).toBe(true);
    expect(laptop.data.serverVersion).toBe(phone.data.serverVersion + 1);
    // The line the phone added is still there, and the laptop's newer change
    // to product-1 won.
    expect(laptop.data.items).toEqual([
      {
        merchantId: MERCHANT,
        productId: "product-1",
        quantity: 2,
        updatedAt: T2,
      },
      {
        merchantId: MERCHANT,
        productId: "product-2",
        quantity: 3,
        updatedAt: T1,
      },
    ]);
  });

  it("keeps both lines when two devices sync at the same time", async () => {
    const initial = await sync({
      cartId: "cart-1",
      clientVersion: 0,
      items: [],
    });
    const baseVersion = initial.data.serverVersion;

    const [phone, laptop] = await Promise.all([
      sync({
        cartId: "cart-1",
        clientVersion: baseVersion,
        items: [{ merchantId: MERCHANT, productId: "product-phone", quantity: 1, updatedAt: T1 }],
      }),
      sync({
        cartId: "cart-1",
        clientVersion: baseVersion,
        items: [{ merchantId: MERCHANT, productId: "product-laptop", quantity: 2, updatedAt: T2 }],
      }),
    ]);

    expect(phone.statusCode).toBe(200);
    expect(laptop.statusCode).toBe(200);

    // The cart holds both lines and the version moved forward twice.
    const { cart, lines } = store.snapshot("cart-1");
    expect(cart.version).toBe(baseVersion + 2);
    expect(lines.filter((l) => l.quantity > 0).map((l) => l.productId).sort()).toEqual([
      "product-laptop",
      "product-phone",
    ]);
  });

  it("does not let an outdated device resurrect a removed line", async () => {
    const initial = await sync({
      cartId: "cart-1",
      clientVersion: 0,
      items: [{ merchantId: MERCHANT, productId: "product-1", quantity: 1, updatedAt: T0 }],
    });
    const baseVersion = initial.data.serverVersion;

    // The phone removes the line and syncs.
    const phone = await sync({
      cartId: "cart-1",
      clientVersion: baseVersion,
      items: [{ merchantId: MERCHANT, productId: "product-1", quantity: 0, updatedAt: T1 }],
    });
    expect(phone.data.items).toHaveLength(0);

    // The laptop still holds the line and syncs from the old version.
    const laptop = await sync({
      cartId: "cart-1",
      clientVersion: baseVersion,
      items: [{ merchantId: MERCHANT, productId: "product-1", quantity: 1, updatedAt: T0 }],
    });

    expect(laptop.data.items).toHaveLength(0);
  });

  it("re-adds a line the buyer picked up again on an up-to-date device", async () => {
    const initial = await sync({
      cartId: "cart-1",
      clientVersion: 0,
      items: [{ merchantId: MERCHANT, productId: "product-1", quantity: 1, updatedAt: T0 }],
    });

    const removed = await sync({
      cartId: "cart-1",
      clientVersion: initial.data.serverVersion,
      items: [{ merchantId: MERCHANT, productId: "product-1", quantity: 0, updatedAt: T1 }],
    });
    expect(removed.data.items).toHaveLength(0);

    const readded = await sync({
      cartId: "cart-1",
      clientVersion: removed.data.serverVersion,
      items: [{ merchantId: MERCHANT, productId: "product-1", quantity: 4, updatedAt: T2 }],
    });

    expect(readded.data.items).toEqual([
      {
        merchantId: MERCHANT,
        productId: "product-1",
        quantity: 4,
        updatedAt: T2,
      },
    ]);
  });

  it("refuses to sync a cart that belongs to another user", async () => {
    await sync({
      cartId: "cart-1",
      clientVersion: 0,
      items: [],
    });

    const result = await sync({ cartId: "cart-1", clientVersion: 1, items: [] }, "user-2");

    expect(result.statusCode).toBe(403);
    expect(result.body.error.code).toBe("FORBIDDEN");
  });
});
