/**
 * Lua script management routes
 * Issue #156
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "@delegolabs/utils";
import { extractAuth, getAuthenticatedUserContext } from "../../gateway/middleware/auth.js";
import { unauthorized, forbidden, badRequest, notFound, sendApiError } from "../../gateway/src/errors.js";
import { registerScript, getScript, listScripts, getScriptRegistry, deleteScript } from "./registry.js";
import { runTestSuite, validateScriptSyntax, generateTestReport } from "./testing.js";
import { deployScript, rollbackDeployment, getScriptMetrics } from "./deployment.js";
import type { LuaScript } from "@delegolabs/types";

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

export async function registerScriptHandler(
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

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    badRequest(res, "Invalid JSON body", req);
    return;
  }

  const { name, version, source, description, params, dependencies, testCases } = body;

  if (typeof name !== "string" || typeof version !== "string" || typeof source !== "string") {
    badRequest(res, "Name, version, and source are required", req);
    return;
  }

  const validation = validateScriptSyntax(source);
  if (!validation.valid) {
    badRequest(res, `Invalid Lua syntax: ${validation.error}`, req);
    return;
  }

  const script: LuaScript = {
    name,
    version,
    sha: "",
    source,
    description: typeof description === "string" ? description : "",
    params: Array.isArray(params) ? params as LuaScript["params"] : [],
    dependencies: Array.isArray(dependencies) ? dependencies as string[] : [],
    testCases: Array.isArray(testCases) ? testCases as LuaScript["testCases"] : [],
  };

  try {
    const registry = registerScript(script);
    json(res, 201, { data: registry, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to register script";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

export async function listScriptsHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const scripts = listScripts();
    json(res, 200, { data: { scripts, total: scripts.length }, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list scripts";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

export async function getScriptHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const version = url.searchParams.get("version") ?? undefined;

  try {
    const script = getScript(params.name, version);
    if (!script) {
      notFound(res, "Script not found", req);
      return;
    }
    const registry = getScriptRegistry(params.name);
    json(res, 200, { data: { script, registry }, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get script";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

export async function testScriptHandler(
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
    const script = getScript(params.name);
    if (!script) {
      notFound(res, "Script not found", req);
      return;
    }

    const suite = runTestSuite(script);
    const report = generateTestReport(suite);

    json(res, 200, {
      data: {
        suite,
        report,
      },
      error: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to test script";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

export async function deployScriptHandler(
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

  let body: Record<string, unknown> = {};
  try {
    body = await readJsonBody(req);
  } catch {
    // Body is optional
  }

  const version = body.version as string | undefined;
  const scriptVersion = version ?? getScriptRegistry(params.name)?.currentVersion;

  if (!scriptVersion) {
    badRequest(res, "Version is required", req);
    return;
  }

  try {
    const deployment = await deployScript(params.name, scriptVersion, auth.userId);
    json(res, 200, { data: deployment, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to deploy script";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

export async function rollbackScriptHandler(
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

  const { targetVersion } = body;
  if (typeof targetVersion !== "string") {
    badRequest(res, "targetVersion is required", req);
    return;
  }

  try {
    const deployment = await rollbackDeployment(params.name, targetVersion, auth.userId);
    json(res, 200, { data: deployment, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to rollback script";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

export async function getScriptMetricsHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const version = url.searchParams.get("version") ?? undefined;

  try {
    const metricsData = getScriptMetrics(params.name, version);
    json(res, 200, { data: { metrics: metricsData }, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get metrics";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

export async function deleteScriptHandler(
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
    const deleted = deleteScript(params.name);
    if (!deleted) {
      notFound(res, "Script not found", req);
      return;
    }
    json(res, 200, { data: { message: "Script deleted" }, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete script";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}
