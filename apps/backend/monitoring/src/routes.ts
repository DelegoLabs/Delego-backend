/**
 * Monitoring service routes
 * Issue #157
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "@delegolabs/utils";
import { extractAuth, getAuthenticatedUserContext } from "../../gateway/middleware/auth.js";
import { unauthorized, forbidden, badRequest, notFound } from "../../gateway/src/errors.js";
import {
  createSchedule,
  getSchedule,
  listSchedules,
  updateSchedule,
  deleteSchedule,
  getCurrentOnCall,
  getTeamSchedules,
} from "./schedule.js";
import {
  createPolicy,
  getPolicy,
  listPolicies,
} from "./escalation.js";
import {
  createRoute,
  listRoutes,
  createAlert,
  listAlerts,
  acknowledgeAlert,
  resolveAlert,
  getActiveSilences,
} from "./alertRouter.js";
import {
  registerChannel,
  listChannels,
  sendNotification,
} from "./notifications.js";
import type { OnCallSchedule, EscalationPolicy, AlertRoute, Alert, NotificationChannel } from "@delegolabs/types";

function isAdmin(req: IncomingMessage): boolean {
  const ctx = getAuthenticatedUserContext(req);
  return ctx?.roles?.includes("admin") ?? false;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// Schedule handlers
export async function createScheduleHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }
  if (!isAdmin(req)) { forbidden(res, "Admin role required", req); return; }

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); } catch { badRequest(res, "Invalid JSON body", req); return; }

  const { name, team, timezone, rotations, overrides } = body;
  if (typeof name !== "string" || typeof team !== "string") {
    badRequest(res, "Name and team are required", req); return;
  }

  const schedule: OnCallSchedule = {
    id: `schedule_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    name,
    team,
    timezone: typeof timezone === "string" ? timezone : "UTC",
    rotations: Array.isArray(rotations) ? rotations : [],
    overrides: Array.isArray(overrides) ? overrides : [],
  };

  const created = createSchedule(schedule);
  json(res, 201, { data: created, error: null });
}

export async function listSchedulesHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const team = url.searchParams.get("team");

  const schedules = team ? getTeamSchedules(team) : listSchedules();
  json(res, 200, { data: { schedules, total: schedules.length }, error: null });
}

export async function getScheduleHandler(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }

  const schedule = getSchedule(params.id);
  if (!schedule) { notFound(res, "Schedule not found", req); return; }
  json(res, 200, { data: schedule, error: null });
}

export async function updateScheduleHandler(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }
  if (!isAdmin(req)) { forbidden(res, "Admin role required", req); return; }

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); } catch { badRequest(res, "Invalid JSON body", req); return; }

  const updated = updateSchedule(params.id, body as Partial<OnCallSchedule>);
  if (!updated) { notFound(res, "Schedule not found", req); return; }
  json(res, 200, { data: updated, error: null });
}

export async function deleteScheduleHandler(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }
  if (!isAdmin(req)) { forbidden(res, "Admin role required", req); return; }

  const deleted = deleteSchedule(params.id);
  if (!deleted) { notFound(res, "Schedule not found", req); return; }
  json(res, 200, { data: { message: "Schedule deleted" }, error: null });
}

export async function getCurrentOnCallHandler(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }

  const onCall = getCurrentOnCall(params.id);
  json(res, 200, { data: { onCall }, error: null });
}

// Policy handlers
export async function createPolicyHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }
  if (!isAdmin(req)) { forbidden(res, "Admin role required", req); return; }

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); } catch { badRequest(res, "Invalid JSON body", req); return; }

  const { name, steps } = body;
  if (typeof name !== "string" || !Array.isArray(steps)) {
    badRequest(res, "Name and steps are required", req); return;
  }

  const policy: EscalationPolicy = {
    id: `policy_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    name,
    steps,
  };

  const created = createPolicy(policy);
  json(res, 201, { data: created, error: null });
}

export async function listPoliciesHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }

  const policies = listPolicies();
  json(res, 200, { data: { policies, total: policies.length }, error: null });
}

export async function getPolicyHandler(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }

  const policy = getPolicy(params.id);
  if (!policy) { notFound(res, "Policy not found", req); return; }
  json(res, 200, { data: policy, error: null });
}

// Route handlers
export async function createRouteHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }
  if (!isAdmin(req)) { forbidden(res, "Admin role required", req); return; }

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); } catch { badRequest(res, "Invalid JSON body", req); return; }

  const { name, matchers, escalationPolicyId, continue: continueRoute } = body;
  if (typeof name !== "string" || !Array.isArray(matchers) || typeof escalationPolicyId !== "string") {
    badRequest(res, "Name, matchers, and escalationPolicyId are required", req); return;
  }

  const route: AlertRoute = {
    id: `route_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    name,
    matchers,
    escalationPolicyId,
    continue: typeof continueRoute === "boolean" ? continueRoute : false,
  };

  const created = createRoute(route);
  json(res, 201, { data: created, error: null });
}

export async function listRoutesHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }

  const routes = listRoutes();
  json(res, 200, { data: { routes, total: routes.length }, error: null });
}

// Alert handlers
export async function createAlertHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); } catch { badRequest(res, "Invalid JSON body", req); return; }

  const { title, description, severity, service, team, labels, annotations } = body;
  if (typeof title !== "string" || typeof severity !== "string" || typeof service !== "string") {
    badRequest(res, "Title, severity, and service are required", req); return;
  }

  const alert = createAlert({
    title,
    description: typeof description === "string" ? description : "",
    severity: severity as Alert["severity"],
    service,
    team: typeof team === "string" ? team : "default",
    routedTo: undefined,
    labels: typeof labels === "object" && labels !== null ? labels as Record<string, string> : {},
    annotations: typeof annotations === "object" && annotations !== null ? annotations as Record<string, unknown> : {},
  });

  json(res, 201, { data: alert, error: null });
}

export async function listAlertsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const status = url.searchParams.get("status") ?? undefined;

  const alerts = listAlerts(status);
  json(res, 200, { data: { alerts, total: alerts.length }, error: null });
}

export async function acknowledgeAlertHandler(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }

  const acknowledged = acknowledgeAlert(params.id, auth.userId);
  if (!acknowledged) { notFound(res, "Alert not found", req); return; }
  json(res, 200, { data: { message: "Alert acknowledged" }, error: null });
}

export async function resolveAlertHandler(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }

  const resolved = resolveAlert(params.id, auth.userId);
  if (!resolved) { notFound(res, "Alert not found", req); return; }
  json(res, 200, { data: { message: "Alert resolved" }, error: null });
}

// Channel handlers
export async function createChannelHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }
  if (!isAdmin(req)) { forbidden(res, "Admin role required", req); return; }

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); } catch { badRequest(res, "Invalid JSON body", req); return; }

  const { type, name, config } = body;
  if (typeof type !== "string" || typeof name !== "string" || typeof config !== "object") {
    badRequest(res, "Type, name, and config are required", req); return;
  }

  const channel: NotificationChannel = {
    id: `channel_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    type: type as NotificationChannel["type"],
    name,
    config: config as Record<string, unknown>,
    enabled: true,
  };

  const created = registerChannel(channel);
  json(res, 201, { data: created, error: null });
}

export async function listChannelsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }

  const channels = listChannels();
  json(res, 200, { data: { channels, total: channels.length }, error: null });
}

export async function sendNotificationHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); } catch { badRequest(res, "Invalid JSON body", req); return; }

  const { channelType, targetId, title, message } = body;
  if (typeof channelType !== "string" || typeof targetId !== "string" || typeof title !== "string" || typeof message !== "string") {
    badRequest(res, "channelType, targetId, title, and message are required", req); return;
  }

  const result = await sendNotification(channelType, targetId, title, message);
  json(res, 200, { data: result, error: null });
}

// ─────────────────────────────────────────────────────────────────────────────
// SLO Dashboard Handlers
// ─────────────────────────────────────────────────────────────────────────────

// Dashboard handler
export async function monitoringDashboardHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }

  const firingAlerts = listAlerts("firing");
  const acknowledgedAlerts = listAlerts("acknowledged");
  const resolvedAlerts = listAlerts("resolved");

  json(res, 200, {
    data: {
      summary: {
        firing: firingAlerts.length,
        acknowledged: acknowledgedAlerts.length,
        resolved: resolvedAlerts.length,
        total: firingAlerts.length + acknowledgedAlerts.length + resolvedAlerts.length,
      },
      schedules: listSchedules().length,
      policies: listPolicies().length,
      routes: listRoutes().length,
      channels: listChannels().length,
      silences: getActiveSilences().length,
    },
    error: null,
  });
}
// ─────────────────────────────────────────────────────────────────────────────
// SLO Dashboard Handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SLO Dashboard Handler
 * GET /monitoring/slo/dashboard
 * Returns overall SLO status across all services
 */
export async function sloDashboardHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }

  // In production, this would use the SLOManager
  // For now, return a placeholder structure
  json(res, 200, {
    data: {
      services: [
        { name: "gateway", health: "healthy", slos: 3, incidents: 0 },
        { name: "payments", health: "healthy", slos: 4, incidents: 0 },
        { name: "wallet", health: "healthy", slos: 3, incidents: 0 },
        { name: "notifications", health: "healthy", slos: 2, incidents: 0 },
        { name: "analytics", health: "healthy", slos: 2, incidents: 0 },
        { name: "fraud-detection", health: "healthy", slos: 3, incidents: 0 },
      ],
      summary: {
        totalSLOs: 17,
        healthy: 17,
        warning: 0,
        critical: 0,
        exhausted: 0,
      },
      burnRateAlerts: 0,
      errorBudgetAlerts: 0,
      lastUpdated: new Date().toISOString(),
    },
    error: null,
  });
}

/**
 * Service SLO Dashboard Handler
 * GET /monitoring/slo/dashboard/:service
 * Returns SLO status for a specific service
 */
export async function sloServiceDashboardHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }

  const service = params.service;
  if (!service) { badRequest(res, "Service parameter required", req); return; }

  // In production, this would query SLOManager for the specific service
  const serviceData: Record<string, unknown> = {
    service,
    health: "healthy",
    slos: [
      { name: "availability", target: 0.999, actual: 0.9995, budgetRemaining: 0.95, burnRate: { "1h": 1.0, "6h": 1.1, "24h": 1.05 }, status: "healthy" },
      { name: "latency", target: 0.99, actual: 0.995, budgetRemaining: 0.98, burnRate: { "1h": 1.0, "6h": 1.05, "24h": 1.02 }, status: "healthy" },
      { name: "error_rate", target: 0.999, actual: 0.9998, budgetRemaining: 0.99, burnRate: { "1h": 1.0, "6h": 1.0, "24h": 1.0 }, status: "healthy" },
    ],
    burnRateAlerts: [],
    errorBudgetAlerts: [],
    lastUpdated: new Date().toISOString(),
  };

  json(res, 200, { data: serviceData, error: null });
}

/**
 * SLO Report Handler
 * GET /monitoring/slo/report/:service?start=...&end=...
 * Returns SLO report for a service over a period
 */
export async function sloReportHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }

  const service = params.service;
  if (!service) { badRequest(res, "Service parameter required", req); return; }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const start = url.searchParams.get("start") ?? new Date(Date.now() - 86400000).toISOString();
  const end = url.searchParams.get("end") ?? new Date().toISOString();

  const report = {
    service,
    period: { start, end },
    slos: [
      { name: "availability", target: 0.999, actual: 0.9995, errorBudgetRemaining: 0.95, burnRate: { "1h": 1.0, "6h": 1.1, "24h": 1.05 }, incidents: 0 },
      { name: "latency", target: 0.99, actual: 0.995, errorBudgetRemaining: 0.98, burnRate: { "1h": 1.0, "6h": 1.05, "24h": 1.02 }, incidents: 0 },
      { name: "error_rate", target: 0.999, actual: 0.9998, errorBudgetRemaining: 0.99, burnRate: { "1h": 1.0, "6h": 1.0, "24h": 1.0 }, incidents: 0 },
    ],
    overallHealth: "healthy",
    lastUpdated: new Date().toISOString(),
  };

  json(res, 200, { data: report, error: null });
}

/**
 * Create SLO Handler
 * POST /monitoring/slo
 * Creates a new SLO configuration
 */
export async function createSLOHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }
  if (!isAdmin(req)) { forbidden(res, "Admin role required", req); return; }

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); } catch { badRequest(res, "Invalid JSON body", req); return; }

  const { service, name, sli, target, window, alerting } = body;
  if (typeof service !== "string" || typeof name !== "string" || typeof target !== "number") {
    badRequest(res, "Service, name, and target are required", req); return;
  }

  const slo = {
    id: `slo_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    service,
    name,
    sli: typeof sli === "object" ? sli : { name, description: "", query: "", unit: "ratio" as const, goodThreshold: 0, totalThreshold: 0 },
    target,
    window: (typeof window === "string" ? window : "rolling_24h") as any,
    alerting: typeof alerting === "object" ? alerting : { burnRateThresholds: [] },
    createdAt: new Date().toISOString(),
  };

  json(res, 201, { data: slo, error: null });
}

/**
 * List SLOs Handler
 * GET /monitoring/slo?service=...
 * Lists all SLOs, optionally filtered by service
 */
export async function listSLOsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const service = url.searchParams.get("service");

  // In production, this would query the SLOManager
  const slos = service 
    ? [
        { id: `slo_${service}_availability`, service, name: "availability", target: 0.999, window: "rolling_24h" },
        { id: `slo_${service}_latency`, service, name: "latency", target: 0.99, window: "rolling_24h" },
      ]
    : [
        { id: "slo_gateway_availability", service: "gateway", name: "availability", target: 0.999, window: "rolling_24h" },
        { id: "slo_gateway_latency", service: "gateway", name: "latency", target: 0.99, window: "rolling_24h" },
        { id: "slo_payments_availability", service: "payments", name: "availability", target: 0.999, window: "rolling_24h" },
        { id: "slo_payments_latency", service: "payments", name: "latency", target: 0.99, window: "rolling_24h" },
      ];

  json(res, 200, { data: { slos, total: slos.length }, error: null });
}

/**
 * Evaluate SLO Handler
 * POST /monitoring/slo/evaluate
 * Evaluates SLO status based on actual metrics
 */
export async function evaluateSLOHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }

  let body: Record<string, unknown>;
  try { body = await readJsonBody(req); } catch { badRequest(res, "Invalid JSON body", req); return; }

  const { sloId, service, actualAvailability } = body;
  if (typeof sloId !== "string" || typeof actualAvailability !== "number") {
    badRequest(res, "SLO ID and actual availability are required", req); return;
  }

  // In production, this would use the SLOManager to evaluate
  const result = {
    sloId,
    service,
    actualAvailability,
    status: actualAvailability >= 0.999 ? "healthy" : actualAvailability >= 0.99 ? "warning" : "critical",
    errorBudgetRemaining: actualAvailability >= 0.999 ? 0.95 : actualAvailability >= 0.99 ? 0.5 : 0.1,
    burnRate: { "1h": 1.0, "6h": 1.1, "24h": 1.05 },
    lastUpdated: new Date().toISOString(),
  };

  json(res, 200, { data: result, error: null });
}

/**
 * Get Budget State Handler
 * GET /monitoring/slo/:sloId/budget
 * Returns error budget state for an SLO
 */
export async function getBudgetStateHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) { unauthorized(res, "Authentication required", req); return; }

  const sloId = params.sloId;
  if (!sloId) { badRequest(res, "SLO ID parameter required", req); return; }

  // In production, this would query the ErrorBudgetTracker
  const budgetState = {
    sloId,
    period: {
      start: new Date(Date.now() - 86400000).toISOString(),
      end: new Date().toISOString(),
      window: "rolling_24h",
    },
    target: 0.999,
    actual: 0.9995,
    budget: 36.0,
    consumed: 0.18,
    remaining: 35.82,
    burnRate: { "1h": 1.0, "6h": 1.1, "24h": 1.05 },
    status: { current: "healthy", warningThreshold: 50, criticalThreshold: 80 },
    lastUpdated: new Date().toISOString(),
  };

  json(res, 200, { data: budgetState, error: null });
}