import type { IncomingMessage, ServerResponse } from "node:http";
import { listJobsHandler, createJobHandler, getJobHandler, cancelJobHandler, listRecordsHandler, resolveRecordHandler, getReportHandler, getSummaryHandler, getDiscrepanciesHandler, getDiscrepanciesByTypeHandler, getCurrencyBreakdownHandler, getAutoResolutionStatsHandler } from "./reconciliationRoutes.js";

export function registerReconciliationRoutes(): Array<{ method: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }> {
  return [
    // Reconciliation jobs
    { method: "GET", path: "/api/v1/reconciliation/jobs", handler: listJobsHandler },
    { method: "POST", path: "/api/v1/reconciliation/jobs", handler: createJobHandler },
    { method: "GET", path: "/api/v1/reconciliation/jobs/:id", handler: getJobHandler },
    { method: "PATCH", path: "/api/v1/reconciliation/jobs/:id/cancel", handler: cancelJobHandler },

    // Reconciliation records
    { method: "GET", path: "/api/v1/reconciliation/records", handler: listRecordsHandler },
    { method: "PATCH", path: "/api/v1/reconciliation/records/:id/resolve", handler: resolveRecordHandler },

    // Reports
    { method: "GET", path: "/api/v1/reconciliation/reports/:jobId", handler: getReportHandler },
    { method: "GET", path: "/api/v1/reconciliation/reports/summary", handler: getSummaryHandler },

    // Discrepancies
    { method: "GET", path: "/api/v1/reconciliation/discrepancies", handler: getDiscrepanciesHandler },
    { method: "GET", path: "/api/v1/reconciliation/discrepancies/by-type", handler: getDiscrepanciesByTypeHandler },

    // Currency breakdown
    { method: "GET", path: "/api/v1/reconciliation/currency-breakdown", handler: getCurrencyBreakdownHandler },

    // Auto-resolution stats
    { method: "GET", path: "/api/v1/reconciliation/auto-resolution-stats", handler: getAutoResolutionStatsHandler },
  ];
}
