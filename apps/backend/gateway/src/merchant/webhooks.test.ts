/**
 * Integration tests for merchant webhook delivery inspection and replay.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Pool } from "pg";
import {
  createWebhookHandler,
  listWebhooksHandler,
  getWebhookHandler,
  updateWebhookHandler,
  deleteWebhookHandler,
  getWebhookDeliveriesHandler,
  getWebhookDeliveryHandler,
  replayWebhookDeliveryHandler,
  setWebhookDbPool,
} from "./webhooks.js";

// Mock database
const mockPool = {
  query: vi.fn(),
} as unknown as Pool;

// Mock auth
vi.mock("../middleware/auth.js", () => ({
  extractAuth: vi.fn(() => ({
    userId: "test-user-123",
    merchantId: "test-merchant-456",
  })),
}));

// Mock request/response helpers
vi.mock("../src/request.js", () => ({
  readJsonBody: vi.fn(async (req: IncomingMessage) => {
    return new Promise((resolve) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        resolve(JSON.parse(body));
      });
    });
  }),
  InvalidJsonError: class InvalidJsonError extends Error {},
  BodyTooLargeError: class BodyTooLargeError extends Error {},
}));

vi.mock("../src/errors.js", () => ({
  badRequest: vi.fn((res: ServerResponse, message: string) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "BAD_REQUEST", message } }));
  }),
  notFound: vi.fn((res: ServerResponse, message: string) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message } }));
  }),
  unauthorized: vi.fn((res: ServerResponse, message: string) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message } }));
  }),
  sendApiError: vi.fn((res: ServerResponse, status: number, code: string, message: string) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code, message } }));
  }),
}));

function createMockRequest(body?: any, url?: string): IncomingMessage {
  const req = {
    url: url ?? "/api/v1/merchant/webhooks",
    method: "POST",
    headers: {},
    on: vi.fn((event: string, callback: any) => {
      if (event === "data" && body) {
        callback(JSON.stringify(body));
      }
      if (event === "end") {
        callback();
      }
      return req;
    }),
  } as unknown as IncomingMessage;
  return req;
}

function createMockResponse(): ServerResponse & { statusCode: number; body: string } {
  const res = {
    statusCode: 200,
    body: "",
    writeHead: vi.fn((status: number) => {
      res.statusCode = status;
      return res;
    }),
    end: vi.fn((data?: string) => {
      res.body = data ?? "";
      return res;
    }),
  } as unknown as ServerResponse & { statusCode: number; body: string };
  return res;
}

describe("Merchant Webhook API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setWebhookDbPool(mockPool);
  });

  describe("Webhook CRUD", () => {
    it("should create a webhook", async () => {
      const mockWebhook = {
        id: "webhook-123",
        merchant_id: "test-merchant-456",
        name: "Test Webhook",
        url: "https://example.com/webhook",
        secret: "secret-123",
        events: ["order.created", "payment.completed"],
        headers: { "X-Custom": "value" },
        retry_policy: { maxAttempts: 5, initialDelayMs: 1000, maxDelayMs: 60000, backoffMultiplier: 2 },
        status: "active",
        version: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      vi.mocked(mockPool.query).mockResolvedValueOnce({
        rows: [mockWebhook],
        rowCount: 1,
      } as any);

      const req = createMockRequest({
        name: "Test Webhook",
        url: "https://example.com/webhook",
        events: ["order.created", "payment.completed"],
        headers: { "X-Custom": "value" },
      });
      const res = createMockResponse();

      await createWebhookHandler(req, res);

      expect(res.statusCode).toBe(201);
      const response = JSON.parse(res.body);
      expect(response.data.id).toBe("webhook-123");
      expect(response.data.secret).toBe("secret-123");
    });

    it("should list webhooks for merchant", async () => {
      const mockWebhooks = [
        {
          id: "webhook-1",
          merchant_id: "test-merchant-456",
          name: "Webhook 1",
          url: "https://example.com/webhook1",
          events: ["order.created"],
          headers: {},
          retry_policy: {},
          status: "active",
          version: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          id: "webhook-2",
          merchant_id: "test-merchant-456",
          name: "Webhook 2",
          url: "https://example.com/webhook2",
          events: ["payment.completed"],
          headers: {},
          retry_policy: {},
          status: "paused",
          version: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];

      vi.mocked(mockPool.query).mockResolvedValueOnce({
        rows: mockWebhooks,
        rowCount: 2,
      } as any);

      const req = createMockRequest(undefined, "/api/v1/merchant/webhooks");
      req.method = "GET";
      const res = createMockResponse();

      await listWebhooksHandler(req, res);

      expect(res.statusCode).toBe(200);
      const response = JSON.parse(res.body);
      expect(response.data).toHaveLength(2);
      expect(response.data[0].id).toBe("webhook-1");
    });

    it("should get a specific webhook", async () => {
      const mockWebhook = {
        id: "webhook-123",
        merchant_id: "test-merchant-456",
        name: "Test Webhook",
        url: "https://example.com/webhook",
        events: ["order.created"],
        headers: {},
        retry_policy: {},
        status: "active",
        version: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      vi.mocked(mockPool.query).mockResolvedValueOnce({
        rows: [mockWebhook],
        rowCount: 1,
      } as any);

      const req = createMockRequest(undefined, "/api/v1/merchant/webhooks/webhook-123");
      req.method = "GET";
      const res = createMockResponse();
      const params = { id: "webhook-123" };

      await getWebhookHandler(req, res, params);

      expect(res.statusCode).toBe(200);
      const response = JSON.parse(res.body);
      expect(response.data.id).toBe("webhook-123");
    });

    it("should update a webhook", async () => {
      const mockWebhook = {
        id: "webhook-123",
        merchant_id: "test-merchant-456",
        name: "Updated Webhook",
        url: "https://example.com/webhook",
        events: ["order.created", "payment.completed"],
        headers: {},
        retry_policy: {},
        status: "active",
        version: 2,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      // Check exists
      vi.mocked(mockPool.query).mockResolvedValueOnce({
        rows: [{ id: "webhook-123" }],
        rowCount: 1,
      } as any);

      // Update
      vi.mocked(mockPool.query).mockResolvedValueOnce({
        rows: [mockWebhook],
        rowCount: 1,
      } as any);

      const req = createMockRequest({ name: "Updated Webhook" }, "/api/v1/merchant/webhooks/webhook-123");
      req.method = "PUT";
      const res = createMockResponse();
      const params = { id: "webhook-123" };

      await updateWebhookHandler(req, res, params);

      expect(res.statusCode).toBe(200);
      const response = JSON.parse(res.body);
      expect(response.data.name).toBe("Updated Webhook");
      expect(response.data.version).toBe(2);
    });

    it("should delete a webhook", async () => {
      vi.mocked(mockPool.query).mockResolvedValueOnce({
        rows: [{ id: "webhook-123" }],
        rowCount: 1,
      } as any);

      const req = createMockRequest(undefined, "/api/v1/merchant/webhooks/webhook-123");
      req.method = "DELETE";
      const res = createMockResponse();
      const params = { id: "webhook-123" };

      await deleteWebhookHandler(req, res, params);

      expect(res.statusCode).toBe(204);
    });
  });

  describe("Webhook Deliveries", () => {
    it("should list webhook deliveries with pagination", async () => {
      const mockDeliveries = [
        {
          id: "delivery-1",
          webhook_id: "webhook-123",
          event_id: "event-1",
          event_type: "order.created",
          payload: { orderId: "order-123", amount: 100 },
          attempt: 1,
          status: "delivered",
          response_status: 200,
          response_headers: { "content-type": "application/json" },
          response_body: "OK",
          sent_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        },
        {
          id: "delivery-2",
          webhook_id: "webhook-123",
          event_id: "event-2",
          event_type: "payment.completed",
          payload: { paymentId: "pay-123", amount: 100 },
          attempt: 1,
          status: "failed",
          response_status: 500,
          response_headers: {},
          response_body: "Internal Server Error",
          error: "Server error",
          sent_at: new Date().toISOString(),
        },
      ];

      // Webhook check
      vi.mocked(mockPool.query).mockResolvedValueOnce({
        rows: [{ id: "webhook-123" }],
        rowCount: 1,
      } as any);

      // Deliveries query
      vi.mocked(mockPool.query).mockResolvedValueOnce({
        rows: mockDeliveries,
        rowCount: 2,
      } as any);

      // Count query
      vi.mocked(mockPool.query).mockResolvedValueOnce({
        rows: [{ total: "2" }],
        rowCount: 1,
      } as any);

      const req = createMockRequest(undefined, "/api/v1/merchant/webhooks/webhook-123/deliveries?limit=10&offset=0");
      req.method = "GET";
      const res = createMockResponse();
      const params = { id: "webhook-123" };

      await getWebhookDeliveriesHandler(req, res, params);

      expect(res.statusCode).toBe(200);
      const response = JSON.parse(res.body);
      expect(response.data).toHaveLength(2);
      expect(response.pagination.total).toBe(2);
      expect(response.pagination.limit).toBe(10);
      expect(response.pagination.offset).toBe(0);
    });

    it("should filter deliveries by status", async () => {
      const mockDeliveries = [
        {
          id: "delivery-1",
          webhook_id: "webhook-123",
          event_id: "event-1",
          event_type: "order.created",
          payload: {},
          attempt: 1,
          status: "failed",
          sent_at: new Date().toISOString(),
        },
      ];

      // Webhook check
      vi.mocked(mockPool.query).mockResolvedValueOnce({
        rows: [{ id: "webhook-123" }],
        rowCount: 1,
      } as any);

      // Deliveries query with status filter
      vi.mocked(mockPool.query).mockResolvedValueOnce({
        rows: mockDeliveries,
        rowCount: 1,
      } as any);

      // Count query
      vi.mocked(mockPool.query).mockResolvedValueOnce({
        rows: [{ total: "1" }],
        rowCount: 1,
      } as any);

      const req = createMockRequest(undefined, "/api/v1/merchant/webhooks/webhook-123/deliveries?status=failed");
      req.method = "GET";
      const res = createMockResponse();
      const params = { id: "webhook-123" };

      await getWebhookDeliveriesHandler(req, res, params);

      expect(res.statusCode).toBe(200);
      const response = JSON.parse(res.body);
      expect(response.data).toHaveLength(1);
      expect(response.data[0].status).toBe("failed");
    });

    it("should get a specific delivery", async () => {
      const mockDelivery = {
        id: "delivery-123",
        webhook_id: "webhook-123",
        event_id: "event-1",
        event_type: "order.created",
        payload: { orderId: "order-123", customerEmail: "test@example.com" },
        attempt: 1,
        status: "delivered",
        response_status: 200,
        response_headers: { "content-type": "application/json" },
        response_body: "OK",
        sent_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        merchant_id: "test-merchant-456",
      };

      vi.mocked(mockPool.query).mockResolvedValueOnce({
        rows: [mockDelivery],
        rowCount: 1,
      } as any);

      const req = createMockRequest(undefined, "/api/v1/merchant/webhooks/deliveries/delivery-123");
      req.method = "GET";
      const res = createMockResponse();
      const params = { deliveryId: "delivery-123" };

      await getWebhookDeliveryHandler(req, res, params);

      expect(res.statusCode).toBe(200);
      const response = JSON.parse(res.body);
      expect(response.data.id).toBe("delivery-123");
      // PII should be masked
      expect(response.data.payload.customerEmail).toBe("***MASKED***");
    });
  });

  describe("Webhook Delivery Replay", () => {
    it("should replay a webhook delivery", async () => {
      const mockDelivery = {
        id: "delivery-123",
        webhook_id: "webhook-123",
        event_id: "event-1",
        event_type: "order.created",
        payload: { orderId: "order-123", amount: 100 },
        attempt: 1,
        status: "failed",
        response_status: 500,
        sent_at: new Date().toISOString(),
        // Webhook details
        url: "https://example.com/webhook",
        secret: "secret-123",
        headers: {},
        retry_policy: {},
        version: 1,
        merchant_id: "test-merchant-456",
      };

      const mockNewDelivery = {
        id: "new-delivery-456",
        webhook_id: "webhook-123",
        event_id: "event-1",
        event_type: "order.created",
        payload: { orderId: "order-123", amount: 100 },
        attempt: 2,
        status: "pending",
        sent_at: new Date().toISOString(),
      };

      // Get delivery
      vi.mocked(mockPool.query).mockResolvedValueOnce({
        rows: [mockDelivery],
        rowCount: 1,
      } as any);

      // Insert new delivery
      vi.mocked(mockPool.query).mockResolvedValueOnce({
        rows: [mockNewDelivery],
        rowCount: 1,
      } as any);

      const req = createMockRequest(undefined, "/api/v1/merchant/webhooks/deliveries/delivery-123/replay");
      req.method = "POST";
      const res = createMockResponse();
      const params = { deliveryId: "delivery-123" };

      await replayWebhookDeliveryHandler(req, res, params);

      expect(res.statusCode).toBe(202);
      const response = JSON.parse(res.body);
      expect(response.data.id).toBe("new-delivery-456");
      expect(response.data.attempt).toBe(2);
      expect(response.data.status).toBe("pending");
      expect(response.data.eventId).toBe("event-1");
      expect(response.data.eventType).toBe("order.created");
    });

    it("should mask PII in replayed delivery", async () => {
      const mockDelivery = {
        id: "delivery-123",
        webhook_id: "webhook-123",
        event_id: "event-1",
        event_type: "order.created",
        payload: {
          orderId: "order-123",
          customerEmail: "customer@example.com",
          customerPhone: "+1234567890",
          shippingAddress: "123 Main St",
        },
        attempt: 1,
        status: "failed",
        sent_at: new Date().toISOString(),
        url: "https://example.com/webhook",
        secret: "secret-123",
        headers: {},
        retry_policy: {},
        version: 1,
        merchant_id: "test-merchant-456",
      };

      const mockNewDelivery = {
        id: "new-delivery-456",
        webhook_id: "webhook-123",
        event_id: "event-1",
        event_type: "order.created",
        payload: {
          orderId: "order-123",
          customerEmail: "customer@example.com",
          customerPhone: "+1234567890",
          shippingAddress: "123 Main St",
        },
        attempt: 2,
        status: "pending",
        sent_at: new Date().toISOString(),
      };

      vi.mocked(mockPool.query).mockResolvedValueOnce({
        rows: [mockDelivery],
        rowCount: 1,
      } as any);

      vi.mocked(mockPool.query).mockResolvedValueOnce({
        rows: [mockNewDelivery],
        rowCount: 1,
      } as any);

      const req = createMockRequest(undefined, "/api/v1/merchant/webhooks/deliveries/delivery-123/replay");
      req.method = "POST";
      const res = createMockResponse();
      const params = { deliveryId: "delivery-123" };

      await replayWebhookDeliveryHandler(req, res, params);

      expect(res.statusCode).toBe(202);
      const response = JSON.parse(res.body);
      // PII should be masked in response
      expect(response.data.payload.customerEmail).toBe("***MASKED***");
      expect(response.data.payload.customerPhone).toBe("***MASKED***");
      expect(response.data.payload.shippingAddress).toBe("***MASKED***");
      // Non-PII should remain
      expect(response.data.payload.orderId).toBe("order-123");
    });
  });

  describe("Sensitive Data Masking", () => {
    it("should mask authorization headers in delivery logs", async () => {
      const mockDelivery = {
        id: "delivery-123",
        webhook_id: "webhook-123",
        event_id: "event-1",
        event_type: "order.created",
        payload: {},
        attempt: 1,
        status: "delivered",
        response_status: 200,
        response_headers: {
          "content-type": "application/json",
          "authorization": "Bearer secret-token",
          "x-api-key": "api-key-123",
        },
        sent_at: new Date().toISOString(),
        merchant_id: "test-merchant-456",
      };

      vi.mocked(mockPool.query).mockResolvedValueOnce({
        rows: [mockDelivery],
        rowCount: 1,
      } as any);

      const req = createMockRequest(undefined, "/api/v1/merchant/webhooks/deliveries/delivery-123");
      req.method = "GET";
      const res = createMockResponse();
      const params = { deliveryId: "delivery-123" };

      await getWebhookDeliveryHandler(req, res, params);

      expect(res.statusCode).toBe(200);
      const response = JSON.parse(res.body);
      // Sensitive headers should be masked
      expect(response.data.responseHeaders.authorization).toBe("***MASKED***");
      expect(response.data.responseHeaders["x-api-key"]).toBe("***MASKED***");
      // Non-sensitive headers should remain
      expect(response.data.responseHeaders["content-type"]).toBe("application/json");
    });
  });
});
