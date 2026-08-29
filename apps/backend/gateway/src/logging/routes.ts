/**
 * Logging routes - log search and admin endpoints
 * Issue #151
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "@delegolabs/utils";
import { extractAuth, getAuthenticatedUserContext } from "../../middleware/auth.js";
import { unauthorized, forbidden, sendApiError } from "../errors.js";
import { searchLogs, getLogEntryCount, clearLogStore } from "./logStore.js";
import type { LogSearchQuery } from "@delegolabs/types";

function isAdmin(req: IncomingMessage): boolean {
  const ctx = getAuthenticatedUserContext(req);
  return ctx?.roles?.includes("admin") ?? false;
}

export async function logSearchHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  const query: LogSearchQuery = {
    userId: url.searchParams.get("userId") ?? undefined,
    path: url.searchParams.get("path") ?? undefined,
    method: url.searchParams.get("method") ?? undefined,
    statusCode: url.searchParams.get("statusCode")
      ? parseInt(url.searchParams.get("statusCode")!, 10)
      : undefined,
    startTime: url.searchParams.get("startTime") ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    endTime: url.searchParams.get("endTime") ?? new Date().toISOString(),
    limit: Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10), 1000),
    includeMasked: url.searchParams.get("includeMasked") === "true",
  };

  if (!isAdmin(req)) {
    query.includeMasked = false;
    query.userId = auth.userId;
  }

  try {
    const logs = searchLogs(query);
    json(res, 200, {
      data: {
        logs,
        total: logs.length,
        query: { ...query, includeMasked: query.includeMasked },
      },
      error: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to search logs";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

export async function logStatsHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  if (!isAdmin(req)) {
    forbidden(res, "Admin role required", req);
    return;
  }

  json(res, 200, {
    data: {
      totalEntries: getLogEntryCount(),
      timestamp: new Date().toISOString(),
    },
    error: null,
  });
}

export async function logClearHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  if (!isAdmin(req)) {
    forbidden(res, "Admin role required", req);
    return;
  }

  clearLogStore();

  json(res, 200, {
    data: { message: "Log store cleared" },
    error: null,
  });
}
