import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "@delegolabs/utils";
import { extractAuth, getAuthenticatedUserContext } from "../../gateway/middleware/auth.js";
import { sendApiError, forbidden, unauthorized } from "../../gateway/src/errors.js";
import { reconciliationJobService } from "../reconciliationJobService.js";
import { matcherService } from "../matcherService.js";
import { resolverService } from "../resolverService.js";
import { reportingService } from "../reportingService.js";
import { CreateReconciliationJobRequest, ResolveDiscrepancyRequest, DiscrepancyQuery } from "../schemas.js";

/**
 * Check if user is admin
 */
function isAdmin(req: IncomingMessage): boolean {
  const ctx = getAuthenticatedUserContext(req);
  return ctx?.roles?.includes("admin") ?? false;
}

/**
 * GET /api/v1/reconciliation/jobs
 *
 * List reconciliation jobs
 */
export async function listJobsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const type = url.searchParams.get("type") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);

    const jobs = await reconciliationJobService.listJobs({
      type: type as any,
      status: status as any,
      limit,
      offset,
    });

    json(res, 200, { data: jobs, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list jobs";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * POST /api/v1/reconciliation/jobs
 *
 * Create a new reconciliation job
 */
export async function createJobHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    let body: CreateReconciliationJobRequest;
    try {
      const rawBody = await new Promise<string>((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      body = JSON.parse(rawBody) as CreateReconciliationJobRequest;
    } catch (err) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Invalid JSON body", req);
      return;
    }

    if (!body.startDate || !body.endDate || body.accounts.length === 0) {
      sendApiError(res, 400, "VALIDATION_ERROR", "startDate, endDate, and accounts are required", req);
      return;
    }

    const job = await reconciliationJobService.createJob(body);

    json(res, 201, { data: job, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create job";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/reconciliation/jobs/:id
 *
 * Get job details
 */
export async function getJobHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const id = url.pathname.split("/").pop();

    if (!id) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Job ID required", req);
      return;
    }

    const job = await reconciliationJobService.getJob(id);

    if (!job) {
      sendApiError(res, 404, "NOT_FOUND", "Job not found", req);
      return;
    }

    json(res, 200, { data: job, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get job";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * PATCH /api/v1/reconciliation/jobs/:id/cancel
 *
 * Cancel a reconciliation job
 */
export async function cancelJobHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  if (!isAdmin(req)) {
    forbidden(res, "Admin role required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const id = url.pathname.split("/").pop();

    if (!id) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Job ID required", req);
      return;
    }

    const job = await reconciliationJobService.cancelJob(id);

    if (!job) {
      sendApiError(res, 404, "NOT_FOUND", "Job not found", req);
      return;
    }

    json(res, 200, { data: job, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to cancel job";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/reconciliation/records
 *
 * List reconciliation records
 */
export async function listRecordsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const jobId = url.searchParams.get("jobId") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);

    const records = await matcherService.getRecordsByStatus(status || "", limit);

    json(res, 200, { data: records, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list records";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * PATCH /api/v1/reconciliation/records/:id/resolve
 *
 * Resolve a discrepancy
 */
export async function resolveRecordHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const id = url.pathname.split("/").pop();

    if (!id) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Record ID required", req);
      return;
    }

    let body: ResolveDiscrepancyRequest;
    try {
      const rawBody = await new Promise<string>((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      body = JSON.parse(rawBody) as ResolveDiscrepancyRequest;
    } catch (err) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Invalid JSON body", req);
      return;
    }

    if (!body.resolution) {
      sendApiError(res, 400, "VALIDATION_ERROR", "resolution is required", req);
      return;
    }

    const record = await resolverService.resolveDiscrepancy(
      id,
      body.resolution,
      body.notes,
      auth.userId,
    );

    if (!record) {
      sendApiError(res, 404, "NOT_FOUND", "Record not found", req);
      return;
    }

    json(res, 200, { data: record, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to resolve record";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/reconciliation/reports/:jobId
 *
 * Get reconciliation report
 */
export async function getReportHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const jobId = url.pathname.split("/").pop();

    if (!jobId) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Job ID required", req);
      return;
    }

    const report = await reportingService.getReport(jobId);

    if (!report) {
      sendApiError(res, 404, "NOT_FOUND", "Report not found", req);
      return;
    }

    json(res, 200, { data: report, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get report";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/reconciliation/reports/summary
 *
 * Get summary report
 */
export async function getSummaryHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const summary = await reportingService.getSummary();

    json(res, 200, { data: summary, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get summary";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/reconciliation/discrepancies
 *
 * Get unresolved discrepancies
 */
export async function getDiscrepanciesHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    const pageSize = parseInt(url.searchParams.get("pageSize") || "50", 10);

    const result = await reportingService.getUnresolvedDiscrepancies({ page, pageSize });

    json(res, 200, { data: result, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get discrepancies";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/reconciliation/discrepancies/by-type
 *
 * Get discrepancies grouped by type
 */
export async function getDiscrepanciesByTypeHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const discrepancies = await reportingService.getDiscrepanciesByType();

    json(res, 200, { data: discrepancies, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get discrepancies";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/reconciliation/currency-breakdown
 *
 * Get currency breakdown
 */
export async function getCurrencyBreakdownHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const jobId = url.searchParams.get("jobId") || undefined;

    const breakdown = await reportingService.getCurrencyBreakdown(jobId);

    json(res, 200, { data: breakdown, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get currency breakdown";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/reconciliation/auto-resolution-stats
 *
 * Get auto-resolution statistics
 */
export async function getAutoResolutionStatsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const stats = await resolverService.getAutoResolutionStats();

    json(res, 200, { data: stats, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get auto-resolution stats";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}
