import { z } from "zod";

/**
 * Cart sync contracts (Issue #574).
 *
 * A buyer manages one cart from several devices (mobile browser, desktop app).
 * Every device keeps its own copy of the cart and pushes it to the gateway
 * together with the cart version it last saw (`clientVersion`). The gateway
 * compares that version with the version it holds and, when the client is
 * out of date, merges the two states line by line instead of letting one
 * device overwrite the other.
 */

/** A single cart line, as published by a client and echoed back by the gateway. */
export interface CartLineItemDTO {
  merchantId: string;
  productId: string;
  /** Optional SKU/variant identifier — omitted for products without variants. */
  skuId?: string;
  /**
   * Absolute quantity of the line (never a delta). A quantity of `0` means
   * "this line was removed" and is used by the merge to resolve removals.
   */
  quantity: number;
  /**
   * ISO-8601 timestamp of the last change to this line. The gateway uses it
   * for last-write-wins resolution between two devices.
   */
  updatedAt: string;
}

export interface CartSyncRequest {
  /** Identifier of the cart being synchronised. */
  cartId: string;
  /** The cart version the client last received from the gateway. */
  clientVersion: number;
  /** The client's full view of the cart. */
  items: CartLineItemDTO[];
}

export interface CartSyncResponse {
  cartId: string;
  /** The cart version after the merge — always incremented by a successful sync. */
  serverVersion: number;
  /** The merged cart lines. */
  items: CartLineItemDTO[];
  /**
   * `true` when the client was out of date and the gateway had to reconcile
   * the client's state with the state it already held.
   */
  conflictsResolved: boolean;
}

export const CartSessionStatusSchema = z.enum([
  "active",
  "checkout_pending",
  "completed",
  "expired",
  "cancelled",
]);

export type CartSessionStatus = z.infer<typeof CartSessionStatusSchema>;

export const CartSessionSchema = z.object({
  id: z.string().uuid(),
  buyerId: z.string().min(1).max(64),
  status: CartSessionStatusSchema,
  currency: z.string().min(1).max(12),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  expiresAt: z.coerce.date(),
});

export type CartSession = z.infer<typeof CartSessionSchema>;

export const CartLineItemSchema = z.object({
  id: z.string().uuid(),
  cartId: z.string().uuid(),
  merchantId: z.string().min(1).max(64),
  productId: z.string().min(1).max(64),
  skuId: z.string().min(1).max(64).nullable().optional(),
  quantity: z.number().int().positive(),
  unitPriceStroops: z.bigint(),
  reservedUntil: z.coerce.date().nullable().optional(),
  createdAt: z.coerce.date(),
});

export type CartLineItem = z.infer<typeof CartLineItemSchema>;

export const CreateCartSessionSchema = z.object({
  buyerId: z.string().min(1).max(64),
  currency: z.string().min(1).max(12).default("XLM"),
  expiresAt: z.coerce.date(),
});

export type CreateCartSession = z.infer<typeof CreateCartSessionSchema>;

export const AddCartLineItemSchema = z.object({
  cartId: z.string().uuid(),
  merchantId: z.string().min(1).max(64),
  productId: z.string().min(1).max(64),
  skuId: z.string().min(1).max(64).optional(),
  quantity: z.number().int().positive(),
  unitPriceStroops: z.bigint(),
  reservedUntil: z.coerce.date().optional(),
});

export type AddCartLineItem = z.infer<typeof AddCartLineItemSchema>;
