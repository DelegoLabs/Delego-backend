import { route, type Route } from "@delegolabs/utils";
import {
  getFunnelMetricsHandler,
  getEngagementMetricsHandler,
  listABTestsHandler,
  createABTestHandler,
  getABTestHandler,
  updateABTestHandler,
  startABTestHandler,
  endABTestHandler,
  getCohortAnalysisHandler,
  trackCustomEventHandler,
  exportDataHandler,
  getRevenueMetricsHandler,
} from "./analyticsRoutes.js";

export function registerAnalyticsRoutes(): Route[] {
  return [
    // Funnel metrics
    route("GET", "/api/v1/analytics/funnel", getFunnelMetricsHandler),
    route("GET", "/api/v1/analytics/engagement", getEngagementMetricsHandler),

    // A/B tests
    route("GET", "/api/v1/analytics/ab-tests", listABTestsHandler),
    route("POST", "/api/v1/analytics/ab-tests", createABTestHandler),
    route("GET", "/api/v1/analytics/ab-tests/:id", getABTestHandler),
    route("PATCH", "/api/v1/analytics/ab-tests/:id", updateABTestHandler),
    route("POST", "/api/v1/analytics/ab-tests/:id/start", startABTestHandler),
    route("POST", "/api/v1/analytics/ab-tests/:id/end", endABTestHandler),

    // Cohort analysis
    route("GET", "/api/v1/analytics/cohorts", getCohortAnalysisHandler),

    // Custom events
    route("POST", "/api/v1/analytics/events", trackCustomEventHandler),

    // Revenue attribution
    route("GET", "/api/v1/analytics/revenue", getRevenueMetricsHandler),

    // Data export
    route("POST", "/api/v1/analytics/export", exportDataHandler),
  ];
}
