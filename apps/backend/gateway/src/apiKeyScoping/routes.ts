/**
 * API key management routes
 * Issue #152
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "@delegolabs/utils";
import { extractAuth, getAuthenticatedUserContext } from "../../middleware/auth.js";
import { unauthorized, forbidden, badRequest, notFound, sendApiError } from "../errors.js";
import {
  createApiKey,
  getApiKey,
  listApiKeys,
  revokeApiKey,
  suspendApiKey,
  activateApiKey,
  updateApiKeyScopes,
} from "./service.js";
import type { ApiKeyScope, CreateApiKeyRequest } from "@delegolabs/types";

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

function validateScopes(scopes: unknown): scopes is ApiKeyScope[] {
  if (!Array.isArray(scopes)) return false;
  return scopes.every(
    (s) =>
      typeof s === "object" &&
      s !== null &&
      typeof (s as any).resource === "string" &&
      Array.isArray((s as any).actions)
  );
}

export async function createApiKeyHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    badRequest(res, "Invalid JSON body", req);
    return;
  }

  const { name, scopes, ipAllowlist, ipDenylist, validFrom, validUntil, quota } = body;

  if (typeof name !== "string" || !name.trim()) {
    badRequest(res, "Name is required", req);
    return;
  }

  if (!validateScopes(scopes)) {
    badRequest(res, "Invalid scopes format", req);
    return;
  }

  const request: CreateApiKeyRequest = {
    name: name.trim(),
    scopes: scopes as ApiKeyScope[],
    ipAllowlist: Array.isArray(ipAllowlist) ? ipAllowlist : undefined,
    ipDenylist: Array.isArray(ipDenylist) ? ipDenylist : undefined,
    validFrom: typeof validFrom === "string" ? validFrom : undefined,
    validUntil: typeof validUntil === "string" ? validUntil : undefined,
    quota: typeof quota === "object" && quota !== undefined ? quota as CreateApiKeyRequest["quota"] : undefined,
  };

  try {
    const result = await createApiKey(auth.userId, request);
    json(res, 201, {
      data: {
        ...result.key,
        rawKey: result.rawKey,
      },
      error: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create API key";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

export async function listApiKeysHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const keys = await listApiKeys();
    json(res, 200, {
      data: { keys, total: keys.length },
      error: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list API keys";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

export async function getApiKeyHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const key = await getApiKey(params.id);
    if (!key) {
      notFound(res, "API key not found", req);
      return;
    }
    json(res, 200, { data: key, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get API key";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

export async function revokeApiKeyHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
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

  try {
    const revoked = await revokeApiKey(params.id);
    if (!revoked) {
      notFound(res, "API key not found", req);
      return;
    }
    json(res, 200, { data: { message: "API key revoked" }, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to revoke API key";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

export async function suspendApiKeyHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
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

  try {
    const suspended = await suspendApiKey(params.id);
    if (!suspended) {
      notFound(res, "API key not found", req);
      return;
    }
    json(res, 200, { data: { message: "API key suspended" }, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to suspend API key";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

export async function activateApiKeyHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
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

  try {
    const activated = await activateApiKey(params.id);
    if (!activated) {
      notFound(res, "API key not found or not suspended", req);
      return;
    }
    json(res, 200, { data: { message: "API key activated" }, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to activate API key";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

export async function updateApiKeyScopesHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
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

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    badRequest(res, "Invalid JSON body", req);
    return;
  }

  const { scopes } = body;
  if (!validateScopes(scopes)) {
    badRequest(res, "Invalid scopes format", req);
    return;
  }

  try {
    const updated = await updateApiKeyScopes(params.id, scopes as ApiKeyScope[]);
    if (!updated) {
      notFound(res, "API key not found", req);
      return;
    }
    json(res, 200, { data: updated, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update API key scopes";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}
