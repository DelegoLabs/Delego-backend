import { z } from "zod";

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
