/**
 * Workflow template management API routes.
 *
 * Endpoints (all under /api/v1/templates):
 *   POST   /templates                     Create/register a template (new version)
 *   GET    /templates                     List templates (catalog summary)
 *   GET    /templates/:id                 Get a template (with ?version=)
 *   GET    /templates/:id/versions        List a template's versions
 *   DELETE /templates/:id                 Delete a template
 *   POST   /templates/:id/deprecate       Deprecate a template version (admin)
 *   POST   /templates/:id/instantiate     Instantiate a template into a workflow
 *   GET    /templates/catalog             Marketplace catalog with ratings
 *   POST   /templates/:id/rate            Rate a template (1–5)
 *   POST   /templates/:id/test            Run the template test suite
 *   GET    /templates/:id/docs            Generate template documentation (markdown|json)
 *   GET    /categories                    List available categories (catalog)
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { generateId, json, readBodyWithLimit, PayloadTooLargeError } from "@delegolabs/utils";
import type { WorkflowTemplate, WorkflowTemplateParameter } from "@delegolabs/types";
import { extractAuth, getAuthenticatedUserContext } from "../../../gateway/middleware/auth.js";
import {
  unauthorized,
  forbidden,
  badRequest,
  notFound,
  payloadTooLarge,
  sendApiError,
} from "../../../gateway/src/errors.js";
import {
  resetTemplateRegistry,
  registerTemplate,
  getTemplateByVersion,
  getTemplateRegistryEntry,
  listTemplateVersions,
  listTemplates,
  deleteTemplate,
  deprecateTemplateVersion,
  rateTemplate,
  buildCatalog,
} from "./registry.js";
import { instantiateTemplate } from "./instantiation.js";
import { runTemplateTests } from "./testing.js";
import { generateTemplateDocumentation } from "./documentation.js";

function isAdmin(req: IncomingMessage): boolean {
  const ctx = getAuthenticatedUserContext(req);
  return ctx?.roles?.includes("admin") ?? false;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBodyWithLimit(req);
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function parseTemplateFromBody(body: Record<string, unknown>, createdBy: string): WorkflowTemplate {
  const { name, description, version, category, tags, definition, parameters, parentTemplateId } = body;

  if (
    typeof name !== "string" ||
    name.length === 0 ||
    typeof version !== "string" ||
    version.length === 0 ||
    typeof category !== "string" ||
    !definition ||
    typeof definition !== "object"
  ) {
    throw new Error("name, version, category, and definition are required");
  }

  const now = new Date().toISOString();
  return {
    id: body.id && typeof body.id === "string" ? (body.id as string) : `tpl_${generateId()}`,
    name,
    description: typeof description === "string" ? description : "",
    version,
    category,
    tags: Array.isArray(tags) ? (tags as string[]).filter((t) => typeof t === "string") : [],
    definition: definition as WorkflowTemplate["definition"],
    parameters: Array.isArray(parameters)
      ? (parameters as WorkflowTemplateParameter[]).map((p) => ({
          name: p.name,
          type: p.type,
          required: Boolean(p.required),
          default: p.default,
          validation: p.validation,
          description: p.description ?? "",
        }))
      : [],
    parentTemplateId: typeof parentTemplateId === "string" ? parentTemplateId : undefined,
    createdAt: now,
    updatedAt: now,
    createdBy,
  };
}

// ─── Template CRUD ───────────────────────────────────────────────────────────

export async function createTemplateHandler(
  req: IncomingMessage,
  res: ServerResponse,
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
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      payloadTooLarge(res, err.message, req);
      return;
    }
    badRequest(res, "Invalid JSON body", req);
    return;
  }

  let template: WorkflowTemplate;
  try {
    template = parseTemplateFromBody(body, auth.userId);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : "Invalid template payload", req);
    return;
  }

  try {
    const registered = registerTemplate(template);
    json(res, 201, { data: registered, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to register template";
    sendApiError(res, 500, "TEMPLATE_REGISTRATION_FAILED", message, req);
  }
}

export async function listTemplatesHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const category = url.searchParams.get("category");
  const tag = url.searchParams.get("tag");

  let templates = listTemplates();
  if (category) templates = templates.filter((t) => t.category === category);
  if (tag) templates = templates.filter((t) => t.tags.includes(tag));

  json(res, 200, {
    data: templates.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      version: t.version,
      category: t.category,
      tags: t.tags,
      parentTemplateId: t.parentTemplateId,
    })),
    error: null,
  });
}

export async function getTemplateHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const version = url.searchParams.get("version") ?? undefined;

  try {
    const template = getTemplateByVersion(params.id, version);
    if (!template) {
      notFound(res, `Template not found: ${params.id}`, req);
      return;
    }
    const entry = getTemplateRegistryEntry(params.id);
    json(res, 200, {
      data: {
        template,
        registry: entry
          ? { currentVersion: entry.currentVersion, versions: entry.versions }
          : null,
      },
      error: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get template";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

export async function listTemplateVersionsHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  const versions = listTemplateVersions(params.id).map((t) => ({
    version: t.version,
    name: t.name,
    description: t.description,
  }));
  json(res, 200, { data: { templateId: params.id, versions }, error: null });
}

export async function deleteTemplateHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
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

  if (!deleteTemplate(params.id)) {
    notFound(res, `Template not found: ${params.id}`, req);
    return;
  }
  json(res, 200, { data: { message: "Template deleted" }, error: null });
}

export async function deprecateTemplateVersionHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
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

  const version = body.version;
  if (typeof version !== "string") {
    badRequest(res, "version is required", req);
    return;
  }

  try {
    const deprecated = deprecateTemplateVersion(params.id, version);
    if (!deprecated) {
      notFound(res, `Template version not found: ${params.id}@${version}`, req);
      return;
    }
    json(res, 200, { data: { message: "Template version deprecated" }, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to deprecate template";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

// ─── Marketplace / catalog ───────────────────────────────────────────────────

export async function catalogHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }
  json(res, 200, { data: buildCatalog(), error: null });
}

export async function categoriesHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }
  json(res, 200, { data: { categories: buildCatalog().categories }, error: null });
}

export async function rateTemplateHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
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

  const rating = body.rating;
  if (typeof rating !== "number" || rating < 1 || rating > 5) {
    badRequest(res, "rating must be a number between 1 and 5", req);
    return;
  }

  try {
    const entry = rateTemplate(params.id, { rating, ratedBy: auth.userId });
    if (!entry) {
      notFound(res, `Template not found: ${params.id}`, req);
      return;
    }
    json(res, 200, {
      data: { rating: entry.rating, ratingsCount: entry.ratingsCount },
      error: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to rate template";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

// ─── Instantiation ───────────────────────────────────────────────────────────

export async function instantiateTemplateHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      payloadTooLarge(res, err.message, req);
      return;
    }
    badRequest(res, "Invalid JSON body", req);
    return;
  }

  const parameters =
    body.parameters && typeof body.parameters === "object"
      ? (body.parameters as Record<string, unknown>)
      : {};

  try {
    const result = await instantiateTemplate({
      templateId: params.id,
      templateVersion: typeof body.templateVersion === "string" ? body.templateVersion : undefined,
      parameters,
      instantiatedBy: auth.userId,
    });
    json(res, 201, { data: result, error: null });
  } catch (err) {
    const error = err instanceof Error ? err : new Error("Unknown instantiation error");
    if (error.name === "ParameterValidationError") {
      badRequest(res, error.message, req, (error as Error & { errors?: string[] }).errors);
      return;
    }
    if (error.message.includes("not found")) {
      notFound(res, error.message, req);
      return;
    }
    sendApiError(res, 500, "INSTANTIATION_FAILED", error.message, req);
  }
}

// ─── Testing ─────────────────────────────────────────────────────────────────

export async function testTemplateHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const suite = await runTemplateTests(params.id, {
      instantiatedBy: auth.userId,
    });
    json(res, 200, { data: { suite }, error: null });
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) {
      notFound(res, err.message, req);
      return;
    }
    sendApiError(
      res,
      500,
      "TEMPLATE_TEST_FAILED",
      err instanceof Error ? err.message : "Failed to run template tests",
      req,
    );
  }
}

// ─── Documentation ───────────────────────────────────────────────────────────

export async function templateDocumentationHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const version = url.searchParams.get("version") ?? undefined;
  const format = url.searchParams.get("format") ?? "json";

  try {
    const doc = generateTemplateDocumentation(params.id, version);
    if (format === "markdown") {
      json(res, 200, { data: { name: doc.name, version: doc.version, markdown: doc.markdown }, error: null });
      return;
    }
    json(res, 200, { data: doc, error: null });
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) {
      notFound(res, err.message, req);
      return;
    }
    sendApiError(
      res,
      500,
      "DOCUMENTATION_FAILED",
      err instanceof Error ? err.message : "Failed to generate documentation",
      req,
    );
  }
}

/** Test hook to reset the in-memory registry (used only by tests). */
export { resetTemplateRegistry };
