/**
 * API key scope enforcement middleware
 * Issue #152
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { checkScope } from "./scopeChecker.js";
import { findApiKeyByPrefix, incrementQuotaUsage } from "./service.js";
import { unauthorized, forbidden } from "../errors.js";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("gateway:api-key", process.env.LOG_LEVEL ?? "info");

interface ScopedApiKeyContext {
  keyId: string;
  name: string;
  scopes: Array<{
    resource: string;
    actions: string[];
    conditions?: Record<string, unknown>;
  }>;
}

const apiKeyContexts = new WeakMap<IncomingMessage, ScopedApiKeyContext>();

export function getApiKeyContext(req: IncomingMessage): ScopedApiKeyContext | undefined {
  return apiKeyContexts.get(req);
}

function extractApiKeyFromHeader(req: IncomingMessage): string | null {
  const apiKeyHeader = req.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader) {
    return apiKeyHeader;
  }
  return null;
}

function extractApiKeyFromQuery(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  return url.searchParams.get("api_key");
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

function getResourceFromPath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length >= 3 && segments[0] === "api" && segments[1] === "v1") {
    return segments[2] ?? "unknown";
  }
  return "unknown";
}

function getActionFromMethod(method: string): "read" | "write" | "delete" | "admin" {
  switch (method?.toUpperCase()) {
    case "GET":
    case "HEAD":
    case "OPTIONS":
      return "read";
    case "POST":
    case "PUT":
    case "PATCH":
      return "write";
    case "DELETE":
      return "delete";
    default:
      return "read";
  }
}

export function apiKeyScopeMiddleware(requiredResource?: string, requiredAction?: "read" | "write" | "delete" | "admin") {
  return async (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): Promise<void> => {
    const rawKey = extractApiKeyFromHeader(req) ?? extractApiKeyFromQuery(req);

    if (!rawKey) {
      next();
      return;
    }

    const prefix = rawKey.split("_").slice(0, 2).join("_");
    const apiKeyRecord = await findApiKeyByPrefix(prefix);

    if (!apiKeyRecord) {
      unauthorized(res, "Invalid API key", req);
      return;
    }

    if (apiKeyRecord.status !== "active") {
      forbidden(res, `API key is ${apiKeyRecord.status}`, req);
      return;
    }

    const clientIp = getClientIp(req);
    const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
    const resource = requiredResource ?? getResourceFromPath(pathname);
    const action = requiredAction ?? getActionFromMethod(req.method ?? "GET");

    const checkResult = checkScope({
      resource,
      action,
      scopes: apiKeyRecord.scopes,
      clientIp,
      ipAllowlist: apiKeyRecord.ipAllowlist,
      ipDenylist: apiKeyRecord.ipDenylist,
      validFrom: new Date(apiKeyRecord.validFrom),
      validUntil: apiKeyRecord.validUntil ? new Date(apiKeyRecord.validUntil) : null,
      quota: apiKeyRecord.quota,
    });

    if (!checkResult.allowed) {
      log.warn("API key scope check failed", {
        keyId: apiKeyRecord.id,
        resource,
        action,
        reason: checkResult.reason,
      });
      forbidden(res, checkResult.reason ?? "Insufficient permissions", req);
      return;
    }

    await incrementQuotaUsage(apiKeyRecord.id, resource);

    apiKeyContexts.set(req, {
      keyId: apiKeyRecord.id,
      name: apiKeyRecord.name,
      scopes: apiKeyRecord.scopes,
    });

    next();
  };
}
