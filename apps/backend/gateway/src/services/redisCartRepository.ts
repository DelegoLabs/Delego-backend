/**
 * Redis-backed cart repository (Issue #506).
 *
 * Stores each cart as a Redis hash under key `cart:{walletAddress}` with a
 * 30-day sliding TTL. Every mutation refreshes the expiry. Guest-to-wallet
 * merging combines quantities by productId without dropping any items.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("gateway:redis-cart", process.env.LOG_LEVEL ?? "info");

export const CART_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// ---------------------------------------------------------------------------
// Types (from issue spec)
// ---------------------------------------------------------------------------

export interface CartItem { productId: string; quantity: number; addedAt: string; }

export interface StoredCartEntity {
  walletAddress: string;
  items: CartItem[];
  lastActiveTimestamp: number;
}

// ---------------------------------------------------------------------------
// Minimal Redis interface
// ---------------------------------------------------------------------------

export interface RedisCartClient {
  hset(key: string, field: string, value: string): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  expire(key: string, seconds: number): Promise<number>;
  del(key: string): Promise<number>;
}

export const cartKey = (walletAddress: string): string => `cart:${walletAddress}`;

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class RedisCartRepository {
  constructor(private readonly redis: RedisCartClient) {}

  async get(walletAddress: string): Promise<StoredCartEntity | null> {
    const raw = await this.redis.hget(cartKey(walletAddress), "data");
    if (!raw) return null;
    try { return JSON.parse(raw) as StoredCartEntity; }
    catch { log.warn("Corrupt cart data in Redis", { walletAddress }); return null; }
  }

  async put(entity: StoredCartEntity): Promise<void> {
    const key = cartKey(entity.walletAddress);
    await this.redis.hset(key, "data", JSON.stringify({ ...entity, lastActiveTimestamp: Date.now() }));
    await this.redis.expire(key, CART_TTL_SECONDS);
  }

  async delete(walletAddress: string): Promise<void> {
    await this.redis.del(cartKey(walletAddress));
  }

  /**
   * Merge a guest cart into an authenticated wallet cart.
   * Quantities for matching productIds are summed; items unique to the guest
   * are appended. The guest key is deleted after a successful merge.
   */
  async mergeGuestIntoWallet(guestAddress: string, walletAddress: string): Promise<StoredCartEntity> {
    const [guest, wallet] = await Promise.all([this.get(guestAddress), this.get(walletAddress)]);
    const base: StoredCartEntity = wallet ?? { walletAddress, items: [], lastActiveTimestamp: Date.now() };

    if (!guest?.items.length) { await this.put(base); return base; }

    const byProductId = new Map<string, CartItem>(base.items.map((i) => [i.productId, { ...i }]));
    for (const g of guest.items) {
      const existing = byProductId.get(g.productId);
      if (existing) {
        existing.quantity += g.quantity;
        if (new Date(g.addedAt) < new Date(existing.addedAt)) existing.addedAt = g.addedAt;
      } else {
        byProductId.set(g.productId, { ...g });
      }
    }

    const merged: StoredCartEntity = { walletAddress, items: Array.from(byProductId.values()), lastActiveTimestamp: Date.now() };
    await Promise.all([this.put(merged), this.delete(guestAddress)]);
    log.info("Guest cart merged", { guestAddress, walletAddress, itemCount: merged.items.length });
    return merged;
  }
}

// ---------------------------------------------------------------------------
// Route handler factories
// ---------------------------------------------------------------------------

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => { try { resolve(body ? JSON.parse(body) as Record<string, unknown> : {}); } catch { reject(new Error("Invalid JSON body")); } });
    req.on("error", reject);
  });
}

function walletFromReq(req: IncomingMessage): string | null {
  const h = req.headers["x-wallet-address"];
  return typeof h === "string" && h ? h : null;
}

/** GET /api/v1/cart — returns the caller's cart (or empty) and refreshes TTL. */
export function makeGetCartHandler(repo: RedisCartRepository) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const wallet = walletFromReq(req);
    if (!wallet) { writeJson(res, 401, { data: null, error: { code: "UNAUTHORIZED", message: "X-Wallet-Address header is required" } }); return; }
    const cart = await repo.get(wallet);
    if (cart) await repo.put(cart); // sliding TTL refresh
    writeJson(res, 200, { data: cart ?? { walletAddress: wallet, items: [], lastActiveTimestamp: Date.now() }, error: null });
  };
}

/** PUT /api/v1/cart — replaces the cart items and refreshes the sliding TTL. */
export function makePutCartHandler(repo: RedisCartRepository) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const wallet = walletFromReq(req);
    if (!wallet) { writeJson(res, 401, { data: null, error: { code: "UNAUTHORIZED", message: "X-Wallet-Address header is required" } }); return; }
    let body: Record<string, unknown>;
    try { body = await parseBody(req); }
    catch { writeJson(res, 400, { data: null, error: { code: "VALIDATION_ERROR", message: "Invalid JSON body" } }); return; }
    if (!Array.isArray(body.items)) { writeJson(res, 400, { data: null, error: { code: "VALIDATION_ERROR", message: "items must be an array" } }); return; }
    const entity: StoredCartEntity = { walletAddress: wallet, items: body.items as CartItem[], lastActiveTimestamp: Date.now() };
    await repo.put(entity);
    writeJson(res, 200, { data: entity, error: null });
  };
}

/** POST /api/v1/cart/merge — merges guest cart (body.guestAddress) into the wallet cart. */
export function makeMergeCartHandler(repo: RedisCartRepository) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const wallet = walletFromReq(req);
    if (!wallet) { writeJson(res, 401, { data: null, error: { code: "UNAUTHORIZED", message: "X-Wallet-Address header is required" } }); return; }
    let body: Record<string, unknown>;
    try { body = await parseBody(req); }
    catch { writeJson(res, 400, { data: null, error: { code: "VALIDATION_ERROR", message: "Invalid JSON body" } }); return; }
    const guest = body.guestAddress;
    if (typeof guest !== "string" || !guest) { writeJson(res, 400, { data: null, error: { code: "VALIDATION_ERROR", message: "guestAddress is required" } }); return; }
    const merged = await repo.mergeGuestIntoWallet(guest, wallet);
    writeJson(res, 200, { data: merged, error: null });
  };
}
