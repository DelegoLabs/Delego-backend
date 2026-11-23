import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CartSyncRequest } from "@delegolabs/types";
import { CartSyncRequestSchema, registerCartRoutes, syncCartHandler } from "./cart.js";
import { InMemoryCartRepository } from "../services/inMemoryCartRepository.js";

const { extractAuthMock } = vi.hoisted(() => ({
  extractAuthMock: vi.fn(),
}));

vi.mock("../../middleware/auth.js", () => ({
  extractAuth: (req: IncomingMessage) => extractAuthMock(req),
  getAuthenticatedUserContext: (req: IncomingMessage) => undefined,
}));

let requestBody: unknown = {};
vi.mock("../request.js", () => ({
  readJsonBody: vi.fn(async () => requestBody),
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

function createRequest(): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.headers = { authorization: "Bearer valid-token" };
  return req;
}

const validPayload: CartSyncRequest = {
  cartId: "cart-1",
  clientVersion: 0,
  items: [
    {
      merchantId: "merchant-1",
      productId: "product-1",
      quantity: 2,
      updatedAt: "2026-10-01T10:00:00.000Z",
    },
  ],
};

describe("POST /api/v1/cart/sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestBody = { ...validPayload };
    repository.current = new InMemoryCartRepository();
    extractAuthMock.mockReturnValue({ userId: "user-1", token: "valid-token" });
  });

  describe("request validation", () => {
    it("accepts a valid payload", () => {
      const result = CartSyncRequestSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
    });

    it("rejects a negative client version", () => {
      const result = CartSyncRequestSchema.safeParse({ ...validPayload, clientVersion: -1 });
      expect(result.success).toBe(false);
    });

    it("rejects a non-integer client version", () => {
      const result = CartSyncRequestSchema.safeParse({ ...validPayload, clientVersion: 1.5 });
      expect(result.success).toBe(false);
    });

    it("rejects a missing cartId", () => {
      const result = CartSyncRequestSchema.safeParse({ ...validPayload, cartId: undefined });
      expect(result.success).toBe(false);
    });

    it("rejects a negative quantity", () => {
      const result = CartSyncRequestSchema.safeParse({
        ...validPayload,
        items: [{ ...validPayload.items[0], quantity: -1 }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects a non-numeric quantity", () => {
      const result = CartSyncRequestSchema.safeParse({
        ...validPayload,
        items: [{ ...validPayload.items[0], quantity: "2" }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects an unparseable updatedAt", () => {
      const result = CartSyncRequestSchema.safeParse({
        ...validPayload,
        items: [{ ...validPayload.items[0], updatedAt: "not-a-date" }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects a line without a merchantId", () => {
      const result = CartSyncRequestSchema.safeParse({
        ...validPayload,
        items: [{ productId: "product-1", quantity: 1, updatedAt: "2026-10-01T10:00:00.000Z" }],
      });
      expect(result.success).toBe(false);
    });

    it("returns 400 with the failing fields when the payload is invalid", async () => {
      requestBody = { ...validPayload, clientVersion: "one" };
      const res = createResponse();

      await syncCartHandler(createRequest(), res);

      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(json.error.details.some((d: any) => d.field === "clientVersion")).toBe(true);
    });
  });

  describe("authentication", () => {
    it("returns 401 when the request is not authenticated", async () => {
      extractAuthMock.mockReturnValue({ userId: null, token: null });
      const res = createResponse();

      await syncCartHandler(createRequest(), res);

      expect(res.statusCode).toBe(401);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 403 when the cart belongs to another user", async () => {
      await syncCartHandler(createRequest(), createResponse());
      extractAuthMock.mockReturnValue({ userId: "user-2", token: "valid-token" });
      const res = createResponse();

      await syncCartHandler(createRequest(), res);

      expect(res.statusCode).toBe(403);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe("FORBIDDEN");
    });
  });

  describe("successful sync", () => {
    it("returns 200 with the merged cart and an incremented server version", async () => {
      const res = createResponse();

      await syncCartHandler(createRequest(), res);

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.error).toBeNull();
      expect(json.data.cartId).toBe("cart-1");
      expect(json.data.serverVersion).toBe(1);
      expect(json.data.conflictsResolved).toBe(false);
      expect(json.data.items).toEqual([
        {
          merchantId: "merchant-1",
          productId: "product-1",
          quantity: 2,
          updatedAt: "2026-10-01T10:00:00.000Z",
        },
      ]);
    });

    it("increments the server version on every sync", async () => {
      await syncCartHandler(createRequest(), createResponse());

      requestBody = { ...validPayload, clientVersion: 1 };
      const res = createResponse();
      await syncCartHandler(createRequest(), res);

      const json = JSON.parse(res.body);
      expect(json.data.serverVersion).toBe(2);
    });

    it("rejects a path cartId that does not match the body", async () => {
      const res = createResponse();

      await syncCartHandler(createRequest(), res, { cartId: "cart-other" });

      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe("VALIDATION_ERROR");
    });

    it("accepts a path cartId that matches the body", async () => {
      const res = createResponse();

      await syncCartHandler(createRequest(), res, { cartId: "cart-1" });

      expect(res.statusCode).toBe(200);
    });
  });

  describe("route registration", () => {
    it("registers the cart sync routes", () => {
      const routes = registerCartRoutes();
      const paths = routes.map((r) => r.pattern.source);

      expect(paths).toContain("^\\/api\\/v1\\/cart\\/sync$");
      expect(paths).toContain("^\\/api\\/v1\\/carts\\/([^/]+)\\/sync$");
      expect(routes.every((r) => r.method === "POST")).toBe(true);
    });
  });
});
