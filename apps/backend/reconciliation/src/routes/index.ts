import { route, type Route } from "@delegolabs/utils";
import { listJobsHandler, createJobHandler, getJobHandler, cancelJobHandler, listRecordsHandler, resolveRecordHandler, getReportHandler, getSummaryHandler, getDiscrepanciesHandler, getDiscrepanciesByTypeHandler, getCurrencyBreakdownHandler, getAutoResolutionStatsHandler } from "./reconciliationRoutes.js";

export function registerReconciliationRoutes(): Route[] {
  return [
    // Reconciliation jobs
    route("GET", "/api/v1/reconciliation/jobs", listJobsHandler),
    route("POST", "/api/v1/reconciliation/jobs", createJobHandler),
    route("GET", "/api/v1/reconciliation/jobs/:id", getJobHandler),
    route("PATCH", "/api/v1/reconciliation/jobs/:id/cancel", cancelJobHandler),

    // Reconciliation records
    route("GET", "/api/v1/reconciliation/records", listRecordsHandler),
    route("PATCH", "/api/v1/reconciliation/records/:id/resolve", resolveRecordHandler),

    // Reports
    route("GET", "/api/v1/reconciliation/reports/summary", getSummaryHandler),
    route("GET", "/api/v1/reconciliation/reports/:jobId", getReportHandler),

    // Discrepancies
    route("GET", "/api/v1/reconciliation/discrepancies", getDiscrepanciesHandler),
    route("GET", "/api/v1/reconciliation/discrepancies/by-type", getDiscrepanciesByTypeHandler),

    // Currency breakdown
    route("GET", "/api/v1/reconciliation/currency-breakdown", getCurrencyBreakdownHandler),

    // Auto-resolution stats
    route("GET", "/api/v1/reconciliation/auto-resolution-stats", getAutoResolutionStatsHandler),
  ];
}
