/**
 * Issue #66 — Audit log query API.
 *
 * All routes require the caller to carry a valid JWT that includes the
 * "admin" role — the audit log records who changed what across the whole
 * system, so reading it is itself an admin-only capability, same pattern
 * as `admin.ts`'s rate-limit dashboard.
 *
 * Routes
 * ------
 *   GET /api/v1/admin/audit-log
 *     Query the audit log with filtering + cursor pagination. Query params:
 *       tableName, recordId, operation (INSERT|UPDATE|DELETE), userId,
 *       from, to (ISO-8601 timestamps), limit (1-100, default 20),
 *       cursor, sort (asc|desc, default desc).
 *
 *   GET /api/v1/admin/audit-log/verify
 *     Walks the hash chain (optionally scoped to a from/to window) and
 *     reports whether it's intact. Meant as an on-demand integrity check,
 *     not something called on every request — see
 *     docs/deployment/audit-log-siem-retention.md for how this fits into
 *     a real monitoring setup.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Pool } from "pg";
import {
  json,
  queryAuditLog,
  getChainSegment,
  verifyChain,
  type AuditOperation,
} from "@delegolabs/utils";
import { extractAuth, getAuthenticatedUserContext } from "../middleware/auth.js";
import { sendApiError, forbidden, unauthorized } from "../src/errors.js";

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const databaseUrl =
      process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego";
    pool = new Pool({ connectionString: databaseUrl });
  }
  return pool;
}

export function _setPoolForTesting(testPool: Pool): void {
  pool = testPool;
}

export function _resetPoolForTesting(): void {
  pool = null;
}

const VALID_OPERATIONS: readonly AuditOperation[] = ["INSERT", "UPDATE", "DELETE"];

function isAdmin(req: IncomingMessage): boolean {
  const ctx = getAuthenticatedUserContext(req);
  return ctx?.roles?.includes("admin") ?? false;
}

/** Parse an ISO-8601 query param into a Date, or return an error message if it's present but invalid. */
function parseDateParam(raw: string | null, field: string): { value?: Date; error?: string } {
  if (raw === null) return {};
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return { error: `${field} must be a valid ISO-8601 timestamp` };
  }
  return { value: date };
}

/**
 * GET /api/v1/admin/audit-log
 */
export async function auditLogQueryHandler(
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

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const params = url.searchParams;

  const operationParam = params.get("operation");
  if (operationParam !== null && !VALID_OPERATIONS.includes(operationParam as AuditOperation)) {
    sendApiError(
      res,
      400,
      "VALIDATION_ERROR",
      `operation must be one of ${VALID_OPERATIONS.join(", ")}`,
      req
    );
    return;
  }

  const sortParam = params.get("sort");
  if (sortParam !== null && sortParam !== "asc" && sortParam !== "desc") {
    sendApiError(res, 400, "VALIDATION_ERROR", "sort must be 'asc' or 'desc'", req);
    return;
  }

  const limitParam = params.get("limit");
  let limit: number | undefined;
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      sendApiError(res, 400, "VALIDATION_ERROR", "limit must be an integer between 1 and 100", req);
      return;
    }
    limit = parsed;
  }

  const from = parseDateParam(params.get("from"), "from");
  if (from.error) {
    sendApiError(res, 400, "VALIDATION_ERROR", from.error, req);
    return;
  }
  const to = parseDateParam(params.get("to"), "to");
  if (to.error) {
    sendApiError(res, 400, "VALIDATION_ERROR", to.error, req);
    return;
  }

  try {
    const result = await queryAuditLog(getPool(), {
      tableName: params.get("tableName") ?? undefined,
      recordId: params.get("recordId") ?? undefined,
      operation: (operationParam as AuditOperation | null) ?? undefined,
      userId: params.get("userId") ?? undefined,
      from: from.value,
      to: to.value,
      limit,
      cursor: params.get("cursor") ?? undefined,
      sort: (sortParam as "asc" | "desc" | null) ?? undefined,
    });

    json(res, 200, {
      data: {
        entries: result.entries,
        nextCursor: result.nextCursor,
      },
      error: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to query audit log";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/admin/audit-log/verify
 */
export async function auditLogVerifyHandler(
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

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const params = url.searchParams;

  const from = parseDateParam(params.get("from"), "from");
  if (from.error) {
    sendApiError(res, 400, "VALIDATION_ERROR", from.error, req);
    return;
  }
  const to = parseDateParam(params.get("to"), "to");
  if (to.error) {
    sendApiError(res, 400, "VALIDATION_ERROR", to.error, req);
    return;
  }

  try {
    const segment = await getChainSegment(getPool(), { from: from.value, to: to.value });
    const result = verifyChain(segment);
    json(res, 200, { data: result, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to verify audit log chain";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}
