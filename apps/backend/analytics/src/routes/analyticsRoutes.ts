import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "@delegolabs/utils";
import { extractAuth, getAuthenticatedUserContext } from "../../gateway/middleware/auth.js";
import { sendApiError, forbidden, unauthorized } from "../../gateway/src/errors.js";
import { analyticsService } from "../services/analyticsService.js";
import { abTestService } from "../services/abTestService.js";
import { cohortService } from "../services/cohortService.js";
import { revenueService } from "../services/revenueService.js";
import { customEventService } from "../services/customEventService.js";
import { exportService } from "../services/exportService.js";
import { FunnelMetricsQuery, FunnelMetricsResponse, EngagementMetricsQuery, EngagementMetricsResponse } from "../schemas.js";
import { ABTestCreateRequest, ABTestUpdateRequest, CustomEventRequest, ExportRequest } from "../schemas.js";

/**
 * Check if user is admin
 */
function isAdmin(req: IncomingMessage): boolean {
  const ctx = getAuthenticatedUserContext(req);
  return ctx?.roles?.includes("admin") ?? false;
}

/**
 * GET /api/v1/analytics/funnel
 *
 * Get delivery funnel metrics for notifications
 *
 * Query params:
 *   templateId - Filter by template ID
 *   channel    - Filter by channel (email, push, sms, in-app)
 *   periodStart - Start of period (ISO 8601)
 *   periodEnd   - End of period (ISO 8601)
 *   userId      - Filter by user ID
 */
export async function getFunnelMetricsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const query: FunnelMetricsQuery = {
      templateId: url.searchParams.get("templateId") || undefined,
      channel: url.searchParams.get("channel") || undefined,
      periodStart: url.searchParams.get("periodStart") || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      periodEnd: url.searchParams.get("periodEnd") || new Date().toISOString(),
      userId: url.searchParams.get("userId") || undefined,
    };

    if (!query.periodStart || !query.periodEnd) {
      sendApiError(res, 400, "VALIDATION_ERROR", "periodStart and periodEnd are required", req);
      return;
    }

    const metrics = await analyticsService.getFunnelMetrics(query);

    json(res, 200, { data: metrics, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch funnel metrics";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/analytics/engagement
 *
 * Get engagement metrics per template/channel
 */
export async function getEngagementMetricsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const query: EngagementMetricsQuery = {
      templateId: url.searchParams.get("templateId") || undefined,
      channel: url.searchParams.get("channel") || undefined,
      periodStart: url.searchParams.get("periodStart") || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      periodEnd: url.searchParams.get("periodEnd") || new Date().toISOString(),
      userId: url.searchParams.get("userId") || undefined,
    };

    if (!query.periodStart || !query.periodEnd) {
      sendApiError(res, 400, "VALIDATION_ERROR", "periodStart and periodEnd are required", req);
      return;
    }

    const metrics = await analyticsService.getEngagementMetrics(query);

    json(res, 200, { data: metrics, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch engagement metrics";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/analytics/ab-tests
 *
 * List all A/B tests
 */
export async function listABTestsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const status = url.searchParams.get("status") || undefined;

    const tests = await abTestService.listABTests(status || undefined);

    json(res, 200, { data: tests, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch A/B tests";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * POST /api/v1/analytics/ab-tests
 *
 * Create a new A/B test
 */
export async function createABTestHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    let body: ABTestCreateRequest;
    try {
      const rawBody = await new Promise<string>((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      body = JSON.parse(rawBody) as ABTestCreateRequest;
    } catch (err) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Invalid JSON body", req);
      return;
    }

    // Validate required fields
    if (!body.name || !body.hypothesis || !body.variants || body.variants.length < 2) {
      sendApiError(res, 400, "VALIDATION_ERROR", "name, hypothesis, and at least 2 variants are required", req);
      return;
    }

    const test = await abTestService.createABTest(body);

    json(res, 201, { data: test, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create A/B test";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/analytics/ab-tests/:id
 *
 * Get a specific A/B test
 */
export async function getABTestHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const id = url.pathname.split("/").pop();

    if (!id) {
      sendApiError(res, 400, "VALIDATION_ERROR", "AB test ID required", req);
      return;
    }

    const test = await abTestService.getABTest(id);

    if (!test) {
      sendApiError(res, 404, "NOT_FOUND", "A/B test not found", req);
      return;
    }

    json(res, 200, { data: test, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch A/B test";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * PATCH /api/v1/analytics/ab-tests/:id
 *
 * Update an A/B test
 */
export async function updateABTestHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const id = url.pathname.split("/").pop();

    if (!id) {
      sendApiError(res, 400, "VALIDATION_ERROR", "AB test ID required", req);
      return;
    }

    let body: ABTestUpdateRequest;
    try {
      const rawBody = await new Promise<string>((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      body = JSON.parse(rawBody) as ABTestUpdateRequest;
    } catch (err) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Invalid JSON body", req);
      return;
    }

    const test = await abTestService.updateABTest(id, body);

    if (!test) {
      sendApiError(res, 404, "NOT_FOUND", "A/B test not found", req);
      return;
    }

    json(res, 200, { data: test, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update A/B test";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * POST /api/v1/analytics/ab-tests/:id/start
 *
 * Start an A/B test
 */
export async function startABTestHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const id = url.pathname.split("/").pop();

    if (!id) {
      sendApiError(res, 400, "VALIDATION_ERROR", "AB test ID required", req);
      return;
    }

    const test = await abTestService.startABTest(id);

    if (!test) {
      sendApiError(res, 404, "NOT_FOUND", "A/B test not found", req);
      return;
    }

    json(res, 200, { data: test, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start A/B test";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * POST /api/v1/analytics/ab-tests/:id/end
 *
 * End an A/B test
 */
export async function endABTestHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const id = url.pathname.split("/").pop();

    if (!id) {
      sendApiError(res, 400, "VALIDATION_ERROR", "AB test ID required", req);
      return;
    }

    const test = await abTestService.endABTest(id);

    if (!test) {
      sendApiError(res, 404, "NOT_FOUND", "A/B test not found", req);
      return;
    }

    json(res, 200, { data: test, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to end A/B test";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/analytics/cohorts
 *
 * Get cohort analysis
 */
export async function getCohortAnalysisHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const cohort = url.searchParams.get("cohort") || undefined;

    const analysis = await cohortService.getCohortAnalysis(cohort);

    json(res, 200, { data: analysis, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch cohort analysis";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * POST /api/v1/analytics/events
 *
 * Track custom events
 */
export async function trackCustomEventHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    let body: CustomEventRequest;
    try {
      const rawBody = await new Promise<string>((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      body = JSON.parse(rawBody) as CustomEventRequest;
    } catch (err) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Invalid JSON body", req);
      return;
    }

    if (!body.eventName) {
      sendApiError(res, 400, "VALIDATION_ERROR", "eventName is required", req);
      return;
    }

    const event = await customEventService.trackEvent(body);

    json(res, 201, { data: event, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to track event";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * POST /api/v1/analytics/export
 *
 * Export data to data warehouse
 */
export async function exportDataHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    let body: ExportRequest;
    try {
      const rawBody = await new Promise<string>((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      body = JSON.parse(rawBody) as ExportRequest;
    } catch (err) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Invalid JSON body", req);
      return;
    }

    if (!body.type || !body.destination) {
      sendApiError(res, 400, "VALIDATION_ERROR", "type and destination are required", req);
      return;
    }

    const exportResult = await exportService.exportData(body);

    json(res, 202, { data: exportResult, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to export data";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/analytics/revenue
 *
 * Get revenue attribution metrics
 */
export async function getRevenueMetricsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const templateId = url.searchParams.get("templateId") || undefined;
    const periodStart = url.searchParams.get("periodStart") || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const periodEnd = url.searchParams.get("periodEnd") || new Date().toISOString();

    const breakdown = await revenueService.getRevenueBreakdown(templateId, periodStart, periodEnd);

    // Calculate total revenue
    const totalRevenue = breakdown.reduce((sum, item) => sum + item.revenue, 0);

    json(res, 200, {
      data: {
        totalRevenue,
        breakdown,
      },
      error: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch revenue metrics";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}
