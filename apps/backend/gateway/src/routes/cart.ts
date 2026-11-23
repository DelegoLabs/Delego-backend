/**
 * Cart synchronisation endpoint (Issue #574).
 *
 * POST /api/v1/cart/sync
 *
 * A buyer manages one cart from several devices (mobile browser, desktop
 * app). Every device pushes its own view of the cart together with the cart
 * version it last saw, and the gateway merges the two states instead of
 * letting the newest request overwrite the stored cart.
 *
 * The merge itself lives in the service layer
 * (`src/services/cartSyncService.ts`); this module owns the HTTP contract:
 * authentication, payload validation and response shaping.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Route } from "@delegolabs/utils";
import { route, createLogger } from "@delegolabs/utils";
import type { CartSyncRequest, CartSyncResponse } from "@delegolabs/types";
import { extractAuth } from "../../middleware/auth.js";
import { readJsonBody, InvalidJsonError, BodyTooLargeError } from "../request.js";
import { badRequest, forbidden, sendApiError, success, unauthorized } from "../errors.js";
import { sequelizeCartRepository } from "../services/cartRepository.js";
import { CartOwnershipError, syncCart } from "../services/cartSyncService.js";

const log = createLogger("gateway:cart", process.env.LOG_LEVEL ?? "info");

/** Upper bound on the number of lines a single sync may carry. */
export const MAX_CART_ITEMS = 200;

/** Upper bound on the number of units a single line may hold. */
export const MAX_CART_ITEM_QUANTITY = 9999;

const CartLineItemSchema = z.object({
  merchantId: z
    .string({ required_error: "merchantId is required" })
    .min(1, "merchantId cannot be empty")
    .max(64, "merchantId must be at most 64 characters"),
  productId: z
    .string({ required_error: "productId is required" })
    .min(1, "productId cannot be empty")
    .max(64, "productId must be at most 64 characters"),
  skuId: z
    .string()
    .min(1, "skuId cannot be empty")
    .max(64, "skuId must be at most 64 characters")
    .optional(),
  quantity: z
    .number({ required_error: "quantity is required" })
    .int("quantity must be an integer")
    .min(0, "quantity cannot be negative")
    .max(MAX_CART_ITEM_QUANTITY, `quantity must be at most ${MAX_CART_ITEM_QUANTITY}`),
  updatedAt: z
    .string({ required_error: "updatedAt is required" })
    .refine((val) => !Number.isNaN(Date.parse(val)), "updatedAt must be a valid ISO date string"),
});

export const CartSyncRequestSchema: z.ZodType<CartSyncRequest> = z.object({
  cartId: z
    .string({ required_error: "cartId is required" })
    .min(1, "cartId cannot be empty")
    .max(64, "cartId must be at most 64 characters"),
  clientVersion: z
    .number({ required_error: "clientVersion is required" })
    .int("clientVersion must be an integer")
    .min(0, "clientVersion cannot be negative"),
  items: z
    .array(CartLineItemSchema)
    .max(MAX_CART_ITEMS, `a cart may hold at most ${MAX_CART_ITEMS} lines`),
});

/**
 * POST /api/v1/cart/sync
 *
 * Returns HTTP 200 with the merged cart and the incremented cart version.
 * An outdated `clientVersion` is not an error: the gateway merges the client's
 * state with the state it holds and reports `conflictsResolved: true`.
 */
export async function syncCartHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string> = {},
): Promise<void> {
  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const rawBody = await readJsonBody(req);

    const validationResult = CartSyncRequestSchema.safeParse(rawBody);
    if (!validationResult.success) {
      const details = validationResult.error.errors.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      badRequest(res, "Invalid request body", req, details);
      return;
    }

    const request: CartSyncRequest = validationResult.data;

    // The cart may also be addressed through the path (/api/v1/carts/:cartId/sync).
    const pathCartId = params.cartId;
    if (pathCartId && pathCartId !== request.cartId) {
      badRequest(res, "cartId in the path does not match the cartId in the body", req);
      return;
    }

    const response: CartSyncResponse = await syncCart(
      sequelizeCartRepository,
      request,
      auth.userId,
    );

    success(res, response, req);
  } catch (err) {
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
      return;
    }
    if (err instanceof CartOwnershipError) {
      forbidden(res, err.message, req);
      return;
    }
    log.error("Failed to sync cart", {
      error: err instanceof Error ? err.message : String(err),
      userId: extractAuth(req).userId,
    });
    sendApiError(
      res,
      500,
      "CART_SYNC_FAILED",
      err instanceof Error ? err.message : "Failed to sync cart",
      req,
    );
  }
}

export function registerCartRoutes(): Route[] {
  return [
    route("POST", "/api/v1/cart/sync", syncCartHandler),
    route("POST", "/api/v1/carts/:cartId/sync", syncCartHandler),
  ];
}
