import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import cartRouter from "../src/routes/cart.js";

vi.mock("../src/services/cart.js", () => ({
  addItem: vi.fn(),
  updateItemQuantity: vi.fn(),
  removeItem: vi.fn(),
  getCart: vi.fn(),
}));

vi.mock("../src/services/checkout.js", () => ({
  createCheckoutSession: vi.fn(),
}));

import * as cartService from "../src/services/cart.js";
import * as checkoutService from "../src/services/checkout.js";

const app = express();
app.use(express.json());
app.use("/cart", cartRouter);

const userHeaders = { "x-user-id": "user-123" };

describe("cart routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /cart/items (add to cart)", () => {
    it("adds an item and returns the updated cart", async () => {
      const cart = { id: "cart-1", items: [{ productId: "p1", quantity: 2 }] };
      vi.mocked(cartService.addItem).mockResolvedValue(cart as any);

      const res = await request(app)
        .post("/cart/items")
        .set(userHeaders)
        .send({ productId: "p1", quantity: 2 });

      expect(res.status).toBe(201);
      expect(res.body).toEqual(cart);
      expect(cartService.addItem).toHaveBeenCalledWith("user-123", {
        productId: "p1",
        quantity: 2,
      });
    });

    it("returns 400 when productId is missing", async () => {
      const res = await request(app)
        .post("/cart/items")
        .set(userHeaders)
        .send({ quantity: 1 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
      expect(cartService.addItem).not.toHaveBeenCalled();
    });

    it("returns 400 when quantity is not a positive integer", async () => {
      const res = await request(app)
        .post("/cart/items")
        .set(userHeaders)
        .send({ productId: "p1", quantity: 0 });

      expect(res.status).toBe(400);
      expect(cartService.addItem).not.toHaveBeenCalled();
    });

    it("returns 401 when user is not authenticated", async () => {
      const res = await request(app)
        .post("/cart/items")
        .send({ productId: "p1", quantity: 1 });

      expect(res.status).toBe(401);
      expect(cartService.addItem).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /cart/items/:productId (quantity update)", () => {
    it("updates the quantity of an existing item", async () => {
      const cart = { id: "cart-1", items: [{ productId: "p1", quantity: 5 }] };
      vi.mocked(cartService.updateItemQuantity).mockResolvedValue(cart as any);

      const res = await request(app)
        .patch("/cart/items/p1")
        .set(userHeaders)
        .send({ quantity: 5 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(cart);
      expect(cartService.updateItemQuantity).toHaveBeenCalledWith(
        "user-123",
        "p1",
        5,
      );
    });

    it("returns 400 when quantity is negative", async () => {
      const res = await request(app)
        .patch("/cart/items/p1")
        .set(userHeaders)
        .send({ quantity: -1 });

      expect(res.status).toBe(400);
      expect(cartService.updateItemQuantity).not.toHaveBeenCalled();
    });

    it("returns 404 when the item is not in the cart", async () => {
      vi.mocked(cartService.updateItemQuantity).mockRejectedValue(
        Object.assign(new Error("Item not found"), { status: 404 }),
      );

      const res = await request(app)
        .patch("/cart/items/missing")
        .set(userHeaders)
        .send({ quantity: 1 });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /cart/items/:productId (item removal)", () => {
    it("removes the item and returns the updated cart", async () => {
      const cart = { id: "cart-1", items: [] };
      vi.mocked(cartService.removeItem).mockResolvedValue(cart as any);

      const res = await request(app)
        .delete("/cart/items/p1")
        .set(userHeaders);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(cart);
      expect(cartService.removeItem).toHaveBeenCalledWith("user-123", "p1");
    });

    it("returns 401 when user is not authenticated", async () => {
      const res = await request(app).delete("/cart/items/p1");

      expect(res.status).toBe(401);
      expect(cartService.removeItem).not.toHaveBeenCalled();
    });
  });

  describe("POST /cart/checkout (checkout handoff)", () => {
    it("creates a checkout session and returns its redirect URL", async () => {
      vi.mocked(checkoutService.createCheckoutSession).mockResolvedValue({
        id: "sess-1",
        url: "https://checkout.stripe.com/c/pay/sess-1",
      } as any);

      const res = await request(app)
        .post("/cart/checkout")
        .set(userHeaders);

      expect(res.status).toBe(200);
      expect(res.body.url).toBe("https://checkout.stripe.com/c/pay/sess-1");
      expect(checkoutService.createCheckoutSession).toHaveBeenCalledWith(
        "user-123",
      );
    });

    it("returns 409 when the cart is empty", async () => {
      vi.mocked(checkoutService.createCheckoutSession).mockRejectedValue(
        Object.assign(new Error("Cart is empty"), { status: 409 }),
      );

      const res = await request(app)
        .post("/cart/checkout")
        .set(userHeaders);

      expect(res.status).toBe(409);
    });

    it("returns 401 when user is not authenticated", async () => {
      const res = await request(app).post("/cart/checkout");

      expect(res.status).toBe(401);
      expect(checkoutService.createCheckoutSession).not.toHaveBeenCalled();
    });
  });
});
