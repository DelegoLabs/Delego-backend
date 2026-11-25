/**
 * Merchant webhook management API.
 * Provides CRUD operations for merchant webhooks and delivery inspection.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Route } from "@delegolabs/utils";
import { route, createLogger } from "@delegolabs/utils";
import { extractAuth } from "../middleware/auth.js";
import { readJsonBody, InvalidJsonError, BodyTooLargeError } from "../src/request.js";
import { badRequest, notFound, unauthorized, sendApiError } from "../src/errors.js";
import { Pool } from "pg";
import { randomBytes, randomUUID } from "node:crypto";

const log = createLogger("gateway:merchant-webhooks", process.env.LOG_LEVEL ?? "info");

// Database connection (will be injected or use environment)
let dbPool: Pool | null = null;

export function setWebhookDbPool(pool: Pool): void {
  dbPool = pool;
}

function getDbPool(): Pool {
  if (!dbPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL not configured");
    }
    dbPool = new Pool({ connectionString });
  }
  return dbPool;
}

// Types
interface Webhook {
  id: string;
  merchantId: string;
  name: string;
  url: string;
  secret: string;
  events: string[];
  headers: Record<string, string>;
  retryPolicy: {
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
    backoffMultiplier: number;
  };
  status: "active" | "paused" | "disabled";
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempt: number;
  status: "pending" | "delivered" | "failed" | "dead_letter";
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  error?: string;
  nextRetryAt?: string | null;
  sentAt: string;
  completedAt?: string;
}

// Sensitive data masking
const SENSITIVE_HEADERS = ["authorization", "x-api-key", "x-auth-token", "cookie", "set-cookie"];
const PII_FIELDS = ["email", "phone", "address", "ssn", "credit_card", "password"];

function maskSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const masked = { ...headers };
  for (const key of Object.keys(masked)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_HEADERS.includes(lowerKey)) {
      masked[key] = "***MASKED***";
    }
  }
  return masked;
}

function maskPiiInPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...payload };
  
  function maskObject(obj: Record<string, unknown>): void {
    for (const key of Object.keys(obj)) {
      const lowerKey = key.toLowerCase();
      if (PII_FIELDS.includes(lowerKey)) {
        obj[key] = "***MASKED***";
      } else if (typeof obj[key] === "object" && obj[key] !== null) {
        if (Array.isArray(obj[key])) {
          (obj[key] as unknown[]).forEach((item) => {
            if (typeof item === "object" && item !== null) {
              maskObject(item as Record<string, unknown>);
            }
          });
        } else {
          maskObject(obj[key] as Record<string, unknown>);
        }
      }
    }
  }
  
  maskObject(masked);
  return masked;
}

function maskDeliveryForResponse(delivery: WebhookDelivery): WebhookDelivery {
  return {
    ...delivery,
    payload: maskPiiInPayload(delivery.payload),
    responseHeaders: delivery.responseHeaders ? maskSensitiveHeaders(delivery.responseHeaders) : undefined,
  };
}

// Handlers

export async function createWebhookHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const body = await readJsonBody(req);
    const { name, url, events, headers, retryPolicy } = body;

    if (!name || !url || !events || !Array.isArray(events)) {
      badRequest(res, "name, url, and events array are required", req);
      return;
    }

    if (!url.startsWith("https://")) {
      badRequest(res, "Webhook URL must use HTTPS", req);
      return;
    }

    // Get merchant ID from auth or query
    const merchantId = auth.merchantId ?? auth.userId;

    const pool = getDbPool();
    const secret = randomBytes(32).toString("hex");
    const webhookId = randomUUID();

    const result = await pool.query(
      `INSERT INTO webhooks (id, merchant_id, name, url, secret, events, headers, retry_policy, status, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', 1)
       RETURNING *`,
      [
        webhookId,
        merchantId,
        name,
        url,
        secret,
        events,
        JSON.stringify(headers ?? {}),
        JSON.stringify(retryPolicy ?? {
          maxAttempts: 5,
          initialDelayMs: 1000,
          maxDelayMs: 60000,
          backoffMultiplier: 2,
        }),
      ]
    );

    const webhook = result.rows[0];
    log.info("Webhook created", { webhookId, merchantId, name });

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: {
        id: webhook.id,
        merchantId: webhook.merchant_id,
        name: webhook.name,
        url: webhook.url,
        events: webhook.events,
        headers: webhook.headers,
        retryPolicy: webhook.retry_policy,
        status: webhook.status,
        version: webhook.version,
        createdAt: webhook.created_at,
        updatedAt: webhook.updated_at,
        // Secret is only returned on creation
        secret: webhook.secret,
      },
      error: null,
    }));
  } catch (err: any) {
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
      return;
    }
    log.error("Failed to create webhook", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendApiError(res, 500, "WEBHOOK_CREATE_FAILED",
      err instanceof Error ? err.message : "Failed to create webhook", req);
  }
}

export async function listWebhooksHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const merchantId = auth.merchantId ?? auth.userId;
    const pool = getDbPool();

    const result = await pool.query(
      `SELECT id, merchant_id, name, url, events, headers, retry_policy, status, version, created_at, updated_at
       FROM webhooks
       WHERE merchant_id = $1
       ORDER BY created_at DESC`,
      [merchantId]
    );

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: result.rows.map((row: any) => ({
        id: row.id,
        merchantId: row.merchant_id,
        name: row.name,
        url: row.url,
        events: row.events,
        headers: row.headers,
        retryPolicy: row.retry_policy,
        status: row.status,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      error: null,
    }));
  } catch (err: any) {
    log.error("Failed to list webhooks", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendApiError(res, 500, "WEBHOOK_LIST_FAILED",
      err instanceof Error ? err.message : "Failed to list webhooks", req);
  }
}

export async function getWebhookHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const webhookId = params.id;
    if (!webhookId) {
      badRequest(res, "Webhook ID is required", req);
      return;
    }

    const merchantId = auth.merchantId ?? auth.userId;
    const pool = getDbPool();

    const result = await pool.query(
      `SELECT id, merchant_id, name, url, events, headers, retry_policy, status, version, created_at, updated_at
       FROM webhooks
       WHERE id = $1 AND merchant_id = $2`,
      [webhookId, merchantId]
    );

    if (result.rows.length === 0) {
      notFound(res, "Webhook not found", req);
      return;
    }

    const webhook = result.rows[0];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: {
        id: webhook.id,
        merchantId: webhook.merchant_id,
        name: webhook.name,
        url: webhook.url,
        events: webhook.events,
        headers: webhook.headers,
        retryPolicy: webhook.retry_policy,
        status: webhook.status,
        version: webhook.version,
        createdAt: webhook.created_at,
        updatedAt: webhook.updated_at,
      },
      error: null,
    }));
  } catch (err: any) {
    log.error("Failed to get webhook", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendApiError(res, 500, "WEBHOOK_GET_FAILED",
      err instanceof Error ? err.message : "Failed to get webhook", req);
  }
}

export async function updateWebhookHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const webhookId = params.id;
    if (!webhookId) {
      badRequest(res, "Webhook ID is required", req);
      return;
    }

    const body = await readJsonBody(req);
    const merchantId = auth.merchantId ?? auth.userId;
    const pool = getDbPool();

    // Check if webhook exists and belongs to merchant
    const existing = await pool.query(
      `SELECT id FROM webhooks WHERE id = $1 AND merchant_id = $2`,
      [webhookId, merchantId]
    );

    if (existing.rows.length === 0) {
      notFound(res, "Webhook not found", req);
      return;
    }

    // Build update query dynamically
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (body.name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(body.name);
    }
    if (body.url !== undefined) {
      if (!body.url.startsWith("https://")) {
        badRequest(res, "Webhook URL must use HTTPS", req);
        return;
      }
      updates.push(`url = $${paramIndex++}`);
      values.push(body.url);
    }
    if (body.events !== undefined) {
      if (!Array.isArray(body.events)) {
        badRequest(res, "events must be an array", req);
        return;
      }
      updates.push(`events = $${paramIndex++}`);
      values.push(body.events);
    }
    if (body.headers !== undefined) {
      updates.push(`headers = $${paramIndex++}`);
      values.push(JSON.stringify(body.headers));
    }
    if (body.retryPolicy !== undefined) {
      updates.push(`retry_policy = $${paramIndex++}`);
      values.push(JSON.stringify(body.retryPolicy));
    }
    if (body.status !== undefined) {
      if (!["active", "paused", "disabled"].includes(body.status)) {
        badRequest(res, "Invalid status", req);
        return;
      }
      updates.push(`status = $${paramIndex++}`);
      values.push(body.status);
    }

    if (updates.length === 0) {
      badRequest(res, "No fields to update", req);
      return;
    }

    updates.push(`version = version + 1`);
    updates.push(`updated_at = NOW()`);
    values.push(webhookId, merchantId);

    const result = await pool.query(
      `UPDATE webhooks
       SET ${updates.join(", ")}
       WHERE id = $${paramIndex++} AND merchant_id = $${paramIndex++}
       RETURNING *`,
      values
    );

    const webhook = result.rows[0];
    log.info("Webhook updated", { webhookId, merchantId });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: {
        id: webhook.id,
        merchantId: webhook.merchant_id,
        name: webhook.name,
        url: webhook.url,
        events: webhook.events,
        headers: webhook.headers,
        retryPolicy: webhook.retry_policy,
        status: webhook.status,
        version: webhook.version,
        createdAt: webhook.created_at,
        updatedAt: webhook.updated_at,
      },
      error: null,
    }));
  } catch (err: any) {
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
      return;
    }
    log.error("Failed to update webhook", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendApiError(res, 500, "WEBHOOK_UPDATE_FAILED",
      err instanceof Error ? err.message : "Failed to update webhook", req);
  }
}

export async function deleteWebhookHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const webhookId = params.id;
    if (!webhookId) {
      badRequest(res, "Webhook ID is required", req);
      return;
    }

    const merchantId = auth.merchantId ?? auth.userId;
    const pool = getDbPool();

    const result = await pool.query(
      `DELETE FROM webhooks WHERE id = $1 AND merchant_id = $2 RETURNING id`,
      [webhookId, merchantId]
    );

    if (result.rows.length === 0) {
      notFound(res, "Webhook not found", req);
      return;
    }

    log.info("Webhook deleted", { webhookId, merchantId });

    res.writeHead(204);
    res.end();
  } catch (err: any) {
    log.error("Failed to delete webhook", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendApiError(res, 500, "WEBHOOK_DELETE_FAILED",
      err instanceof Error ? err.message : "Failed to delete webhook", req);
  }
}

export async function getWebhookDeliveriesHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const webhookId = params.id;
    if (!webhookId) {
      badRequest(res, "Webhook ID is required", req);
      return;
    }

    const url = new URL(req.url ?? "", "http://localhost");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const status = url.searchParams.get("status");
    const eventType = url.searchParams.get("eventType");

    const merchantId = auth.merchantId ?? auth.userId;
    const pool = getDbPool();

    // Verify webhook belongs to merchant
    const webhookCheck = await pool.query(
      `SELECT id FROM webhooks WHERE id = $1 AND merchant_id = $2`,
      [webhookId, merchantId]
    );

    if (webhookCheck.rows.length === 0) {
      notFound(res, "Webhook not found", req);
      return;
    }

    // Build query with filters
    let query = `SELECT * FROM webhook_deliveries WHERE webhook_id = $1`;
    const queryParams: any[] = [webhookId];
    let paramIndex = 2;

    if (status) {
      query += ` AND status = $${paramIndex++}`;
      queryParams.push(status);
    }
    if (eventType) {
      query += ` AND event_type = $${paramIndex++}`;
      queryParams.push(eventType);
    }

    query += ` ORDER BY sent_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    queryParams.push(limit, offset);

    const result = await pool.query(query, queryParams);

    // Get total count for pagination
    let countQuery = `SELECT COUNT(*) as total FROM webhook_deliveries WHERE webhook_id = $1`;
    const countParams: any[] = [webhookId];
    let countParamIndex = 2;

    if (status) {
      countQuery += ` AND status = $${countParamIndex++}`;
      countParams.push(status);
    }
    if (eventType) {
      countQuery += ` AND event_type = $${countParamIndex++}`;
      countParams.push(eventType);
    }

    const countResult = await pool.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].total, 10);

    const deliveries = result.rows.map((row: any) => maskDeliveryForResponse({
      id: row.id,
      webhookId: row.webhook_id,
      eventId: row.event_id,
      eventType: row.event_type,
      payload: row.payload,
      attempt: row.attempt,
      status: row.status,
      responseStatus: row.response_status,
      responseHeaders: row.response_headers,
      responseBody: row.response_body,
      error: row.error,
      nextRetryAt: row.next_retry_at,
      sentAt: row.sent_at,
      completedAt: row.completed_at,
    }));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: deliveries,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
      error: null,
    }));
  } catch (err: any) {
    log.error("Failed to get webhook deliveries", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendApiError(res, 500, "WEBHOOK_DELIVERIES_FAILED",
      err instanceof Error ? err.message : "Failed to get webhook deliveries", req);
  }
}

export async function getWebhookDeliveryHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const deliveryId = params.deliveryId;
    if (!deliveryId) {
      badRequest(res, "Delivery ID is required", req);
      return;
    }

    const merchantId = auth.merchantId ?? auth.userId;
    const pool = getDbPool();

    const result = await pool.query(
      `SELECT wd.*, w.merchant_id
       FROM webhook_deliveries wd
       JOIN webhooks w ON wd.webhook_id = w.id
       WHERE wd.id = $1 AND w.merchant_id = $2`,
      [deliveryId, merchantId]
    );

    if (result.rows.length === 0) {
      notFound(res, "Delivery not found", req);
      return;
    }

    const row = result.rows[0];
    const delivery = maskDeliveryForResponse({
      id: row.id,
      webhookId: row.webhook_id,
      eventId: row.event_id,
      eventType: row.event_type,
      payload: row.payload,
      attempt: row.attempt,
      status: row.status,
      responseStatus: row.response_status,
      responseHeaders: row.response_headers,
      responseBody: row.response_body,
      error: row.error,
      nextRetryAt: row.next_retry_at,
      sentAt: row.sent_at,
      completedAt: row.completed_at,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: delivery, error: null }));
  } catch (err: any) {
    log.error("Failed to get webhook delivery", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendApiError(res, 500, "WEBHOOK_DELIVERY_FAILED",
      err instanceof Error ? err.message : "Failed to get webhook delivery", req);
  }
}

export async function replayWebhookDeliveryHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const deliveryId = params.deliveryId;
    if (!deliveryId) {
      badRequest(res, "Delivery ID is required", req);
      return;
    }

    const merchantId = auth.merchantId ?? auth.userId;
    const pool = getDbPool();

    // Get the delivery and webhook
    const result = await pool.query(
      `SELECT wd.*, w.url, w.secret, w.headers, w.retry_policy, w.version
       FROM webhook_deliveries wd
       JOIN webhooks w ON wd.webhook_id = w.id
       WHERE wd.id = $1 AND w.merchant_id = $2`,
      [deliveryId, merchantId]
    );

    if (result.rows.length === 0) {
      notFound(res, "Delivery not found", req);
      return;
    }

    const row = result.rows[0];
    
    // Create a new delivery attempt with the same payload
    const newDeliveryId = randomUUID();
    const newAttempt = row.attempt + 1;

    // Re-enqueue the delivery (in production, this would go to BullMQ)
    // For now, we'll create a new pending delivery record
    const insertResult = await pool.query(
      `INSERT INTO webhook_deliveries (
        id, webhook_id, event_id, event_type, payload, attempt, status,
        response_status, response_headers, response_body, error, next_retry_at, sent_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', NULL, NULL, NULL, NULL, NULL, NOW())
      RETURNING *`,
      [
        newDeliveryId,
        row.webhook_id,
        row.event_id,
        row.event_type,
        JSON.stringify(row.payload),
        newAttempt,
      ]
    );

    const newDelivery = insertResult.rows[0];
    log.info("Webhook delivery replayed", {
      originalDeliveryId: deliveryId,
      newDeliveryId,
      webhookId: row.webhook_id,
      attempt: newAttempt,
    });

    // In production, this would trigger actual delivery via BullMQ
    // For now, we return the new delivery record
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: {
        id: newDelivery.id,
        webhookId: newDelivery.webhook_id,
        eventId: newDelivery.event_id,
        eventType: newDelivery.event_type,
        payload: maskPiiInPayload(newDelivery.payload),
        attempt: newDelivery.attempt,
        status: newDelivery.status,
        sentAt: newDelivery.sent_at,
      },
      error: null,
    }));
  } catch (err: any) {
    log.error("Failed to replay webhook delivery", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendApiError(res, 500, "WEBHOOK_REPLAY_FAILED",
      err instanceof Error ? err.message : "Failed to replay webhook delivery", req);
  }
}

export function registerMerchantWebhookRoutes(): Route[] {
  return [
    route("POST", "/api/v1/merchant/webhooks", createWebhookHandler),
    route("GET", "/api/v1/merchant/webhooks", listWebhooksHandler),
    route("GET", "/api/v1/merchant/webhooks/:id", getWebhookHandler),
    route("PUT", "/api/v1/merchant/webhooks/:id", updateWebhookHandler),
    route("DELETE", "/api/v1/merchant/webhooks/:id", deleteWebhookHandler),
    route("GET", "/api/v1/merchant/webhooks/:id/deliveries", getWebhookDeliveriesHandler),
    route("GET", "/api/v1/merchant/webhooks/deliveries/:deliveryId", getWebhookDeliveryHandler),
    route("POST", "/api/v1/merchant/webhooks/deliveries/:deliveryId/replay", replayWebhookDeliveryHandler),
  ];
}
