import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "@delegolabs/utils";
import { extractAuth, getAuthenticatedUserContext } from "../middleware/auth.js";
import { forbidden, unauthorized, sendApiError } from "../src/errors.js";
import { getRASPConfig, getRASPEvents, getRASPMetrics, markRASPFalsePositive, simulateRASPAttack } from "../middleware/rasp.js";

function requireAdmin(req: IncomingMessage, res: ServerResponse): boolean {
  if (!extractAuth(req).userId) { unauthorized(res, "Authentication required", req); return false; }
  if (!getAuthenticatedUserContext(req)?.roles?.includes("admin")) { forbidden(res, "Admin role required", req); return false; }
  return true;
}

export function raspMetricsHandler(req: IncomingMessage, res: ServerResponse): void {
  if (requireAdmin(req, res)) json(res, 200, { data: getRASPMetrics(), error: null });
}

export function raspEventsHandler(req: IncomingMessage, res: ServerResponse): void {
  if (requireAdmin(req, res)) json(res, 200, { data: getRASPEvents(), error: null });
}

export function raspSimulationHandler(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return;
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.searchParams.get("path");
  if (!path) { sendApiError(res, 400, "VALIDATION_ERROR", "path is required", req); return; }
  const event = simulateRASPAttack({ method: url.searchParams.get("method") ?? "GET", path, body: url.searchParams.get("body") ?? undefined, ip: url.searchParams.get("ip") ?? undefined });
  json(res, 200, { data: { event, config: getRASPConfig() }, error: null });
}

export function raspFalsePositiveHandler(req: IncomingMessage, res: ServerResponse): void {
  if (!requireAdmin(req, res)) return;
  markRASPFalsePositive();
  json(res, 200, { data: getRASPMetrics(), error: null });
}
