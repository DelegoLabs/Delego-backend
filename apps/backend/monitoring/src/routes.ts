/**
 * Monitoring service routes
 * Issue #157
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "@delegolabs/utils";
import { extractAuth, getAuthenticatedUserContext } from "../../gateway/middleware/auth.js";
import { unauthorized, forbidden, badRequest, notFound, sendApiError } from "../../gateway/src/errors.js";
import {
  createSchedule,
  getSchedule,
  listSchedules,
  updateSchedule,
  deleteSchedule,
  getCurrentOnCall,
  getOnCallUsers,
  addOverride,
  removeOverride,
  createHandoff,
  acknowledgeHandoff,
  getHandoffs,
  getTeamSchedules,
} from "./schedule.js";
import {
  createPolicy,
  getPolicy,
  listPolicies,
  updatePolicy,
  deletePolicy,
  getActiveEscalation,
  resolveEscalation,
  getEscalationHistory,
} from "./escalation.js";
import {
  createRoute,
  getRoute,
  listRoutes,
  updateRoute,
  deleteRoute,
  createAlert,
  getAlert,
  listAlerts,
  acknowledgeAlert,
  resolveAlert,
  silenceAlert,
  removeSilence,
  getActiveSilences,
  getAlertGroups,
} from "./alertRouter.js";
import {
  registerChannel,
  getChannel,
  listChannels,
  updateChannel,
  deleteChannel,
  sendNotification,
  getDeliveryLog,
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
