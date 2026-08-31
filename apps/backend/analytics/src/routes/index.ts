import type { IncomingMessage, ServerResponse } from "node:http";
import { getFunnelMetricsHandler, getEngagementMetricsHandler, listABTestsHandler, createABTestHandler, getABTestHandler, updateABTestHandler, startABTestHandler, endABTestHandler, getCohortAnalysisHandler, trackCustomEventHandler, exportDataHandler, getRevenueMetricsHandler } from "./analyticsRoutes.js";

export function registerAnalyticsRoutes(): Array<{ method: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }> {
  return [
    // Funnel metrics
    { method: "GET", path: "/api/v1/analytics/funnel", handler: getFunnelMetricsHandler },
    { method: "GET", path: "/api/v1/analytics/engagement", handler: getEngagementMetricsHandler },

    // A/B tests
    { method: "GET", path: "/api/v1/analytics/ab-tests", handler: listABTestsHandler },
    { method: "POST", path: "/api/v1/analytics/ab-tests", handler: createABTestHandler },
    { method: "GET", path: "/api/v1/analytics/ab-tests/:id", handler: getABTestHandler },
    { method: "PATCH", path: "/api/v1/analytics/ab-tests/:id", handler: updateABTestHandler },
    { method: "POST", path: "/api/v1/analytics/ab-tests/:id/start", handler: startABTestHandler },
    { method: "POST", path: "/api/v1/analytics/ab-tests/:id/end", handler: endABTestHandler },

    // Cohort analysis
    { method: "GET", path: "/api/v1/analytics/cohorts", handler: getCohortAnalysisHandler },

    // Custom events
    { method: "POST", path: "/api/v1/analytics/events", handler: trackCustomEventHandler },

    // Revenue attribution
    { method: "GET", path: "/api/v1/analytics/revenue", handler: getRevenueMetricsHandler },

    // Data export
    { method: "POST", path: "/api/v1/analytics/export", handler: exportDataHandler },
  ];
}
