import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "@delegolabs/utils";
import { extractAuth, getAuthenticatedUserContext } from "../../gateway/middleware/auth.js";
import { sendApiError, forbidden, unauthorized } from "../../gateway/src/errors.js";
import { fraudCheckService } from "../fraudCheckService.js";
import { ruleEngine } from "../ruleEngine.js";
import { mlScorer } from "../mlScorer.js";
import { caseManagementService } from "../caseManagementService.js";
import { fraudAnalyticsService } from "../analyticsService.js";
import { retrainingService } from "../retrainingService.js";
import { FraudCheckRequest, FraudCheckResponse, CreateFraudRuleRequest, UpdateFraudRuleRequest, CreateFraudCaseRequest, UpdateFraudCaseRequest, AddEvidenceRequest, ModelPerformance, RetrainModelResponse } from "../schemas.js";

/**
 * Check if user is admin
 */
function isAdmin(req: IncomingMessage): boolean {
  const ctx = getAuthenticatedUserContext(req);
  return ctx?.roles?.includes("admin") ?? false;
}

/**
 * POST /api/v1/fraud/check
 *
 * Check a transaction for fraud
 */
export async function checkFraudHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    let body: FraudCheckRequest;
    try {
      const rawBody = await new Promise<string>((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      body = JSON.parse(rawBody) as FraudCheckRequest;
    } catch (err) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Invalid JSON body", req);
      return;
    }

    if (!body.transactionId || !body.customerId || !body.amount) {
      sendApiError(res, 400, "VALIDATION_ERROR", "transactionId, customerId, and amount are required", req);
      return;
    }

    const result = await fraudCheckService.checkTransaction(body);

    json(res, 200, { data: result, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to check fraud";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/rules
 *
 * List all fraud rules
 */
export async function listRulesHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const rules = await ruleEngine.getAllRules();

    json(res, 200, { data: rules, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list rules";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * POST /api/v1/rules
 *
 * Create a new fraud rule
 */
export async function createRuleHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    let body: CreateFraudRuleRequest;
    try {
      const rawBody = await new Promise<string>((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      body = JSON.parse(rawBody) as CreateFraudRuleRequest;
    } catch (err) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Invalid JSON body", req);
      return;
    }

    if (!body.name || !body.description || !body.condition) {
      sendApiError(res, 400, "VALIDATION_ERROR", "name, description, and condition are required", req);
      return;
    }

    const rule = await ruleEngine.createRule(body);

    json(res, 201, { data: rule, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create rule";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/rules/:id
 *
 * Get rule details
 */
export async function getRuleHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const id = url.pathname.split("/").pop();

    if (!id) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Rule ID required", req);
      return;
    }

    const rule = await ruleEngine.getRuleById(id);

    if (!rule) {
      sendApiError(res, 404, "NOT_FOUND", "Rule not found", req);
      return;
    }

    json(res, 200, { data: rule, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get rule";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * PATCH /api/v1/rules/:id
 *
 * Update a rule
 */
export async function updateRuleHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const id = url.pathname.split("/").pop();

    if (!id) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Rule ID required", req);
      return;
    }

    let body: UpdateFraudRuleRequest;
    try {
      const rawBody = await new Promise<string>((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      body = JSON.parse(rawBody) as UpdateFraudRuleRequest;
    } catch (err) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Invalid JSON body", req);
      return;
    }

    const rule = await ruleEngine.updateRule(id, body);

    if (!rule) {
      sendApiError(res, 404, "NOT_FOUND", "Rule not found", req);
      return;
    }

    json(res, 200, { data: rule, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update rule";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * DELETE /api/v1/rules/:id
 *
 * Delete a rule
 */
export async function deleteRuleHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const id = url.pathname.split("/").pop();

    if (!id) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Rule ID required", req);
      return;
    }

    const deleted = await ruleEngine.deleteRule(id);

    if (!deleted) {
      sendApiError(res, 404, "NOT_FOUND", "Rule not found", req);
      return;
    }

    json(res, 200, { data: { message: "Rule deleted" }, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete rule";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * POST /api/v1/rules/evaluate
 *
 * Evaluate rules against a transaction
 */
export async function evaluateRulesHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    let body: FraudCheckRequest;
    try {
      const rawBody = await new Promise<string>((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      body = JSON.parse(rawBody) as FraudCheckRequest;
    } catch (err) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Invalid JSON body", req);
      return;
    }

    const rules = await ruleEngine.loadRules();

    json(res, 200, { data: { rulesTriggered: rules.map((r) => r.name) }, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to evaluate rules";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/model/version
 *
 * Get current model version
 */
export async function getModelVersionHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const version = mlScorer.getVersion();
    const modelInfo = mlScorer.getModelInfo();

    json(res, 200, { data: { version, modelInfo }, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get model version";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * POST /api/v1/model/retrain
 *
 * Trigger model retraining
 */
export async function retrainModelHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    const result = await retrainingService.retrainModel();

    if (result.status === "completed") {
      json(res, 200, { data: result, error: null });
    } else {
      json(res, 500, { data: result, error: result.errorMessage || "Model retraining failed" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to retrain model";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/model/performance
 *
 * Get model performance metrics
 */
export async function getModelPerformanceHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const metrics = await fraudAnalyticsService.getModelPerformance();

    json(res, 200, { data: metrics, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get model performance";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/cases
 *
 * List fraud cases
 */
export async function listCasesHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const status = url.searchParams.get("status") || undefined;
    const priority = url.searchParams.get("priority") || undefined;
    const assignedTo = url.searchParams.get("assignedTo") || undefined;
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);

    const cases = await caseManagementService.listCases({
      status: status as any,
      priority: priority as any,
      assignedTo,
      limit,
      offset,
    });

    json(res, 200, { data: cases, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list cases";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * POST /api/v1/cases
 *
 * Create a fraud case
 */
export async function createCaseHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    let body: CreateFraudCaseRequest;
    try {
      const rawBody = await new Promise<string>((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      body = JSON.parse(rawBody) as CreateFraudCaseRequest;
    } catch (err) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Invalid JSON body", req);
      return;
    }

    if (!body.transactionId) {
      sendApiError(res, 400, "VALIDATION_ERROR", "transactionId is required", req);
      return;
    }

    const caseData = await caseManagementService.createCase(body);

    json(res, 201, { data: caseData, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create case";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/cases/:id
 *
 * Get case details
 */
export async function getCaseHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const id = url.pathname.split("/").pop();

    if (!id) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Case ID required", req);
      return;
    }

    const caseData = await caseManagementService.getCase(id);

    if (!caseData) {
      sendApiError(res, 404, "NOT_FOUND", "Case not found", req);
      return;
    }

    json(res, 200, { data: caseData, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get case";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * PATCH /api/v1/cases/:id
 *
 * Update case status
 */
export async function updateCaseHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const id = url.pathname.split("/").pop();

    if (!id) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Case ID required", req);
      return;
    }

    let body: UpdateFraudCaseRequest;
    try {
      const rawBody = await new Promise<string>((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      body = JSON.parse(rawBody) as UpdateFraudCaseRequest;
    } catch (err) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Invalid JSON body", req);
      return;
    }

    const caseData = await caseManagementService.updateCase(id, body);

    if (!caseData) {
      sendApiError(res, 404, "NOT_FOUND", "Case not found", req);
      return;
    }

    json(res, 200, { data: caseData, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update case";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * POST /api/v1/cases/:id/evidence
 *
 * Add evidence to case
 */
export async function addEvidenceHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const id = url.pathname.split("/").pop();

    if (!id) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Case ID required", req);
      return;
    }

    let body: AddEvidenceRequest;
    try {
      const rawBody = await new Promise<string>((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      body = JSON.parse(rawBody) as AddEvidenceRequest;
    } catch (err) {
      sendApiError(res, 400, "VALIDATION_ERROR", "Invalid JSON body", req);
      return;
    }

    if (!body.type || !body.data || !body.addedBy) {
      sendApiError(res, 400, "VALIDATION_ERROR", "type, data, and addedBy are required", req);
      return;
    }

    const caseData = await caseManagementService.addEvidence(id, body);

    if (!caseData) {
      sendApiError(res, 404, "NOT_FOUND", "Case not found", req);
      return;
    }

    json(res, 200, { data: caseData, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to add evidence";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/analytics/fraud-rate
 *
 * Get fraud rate metrics
 */
export async function getFraudRateHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const periodDays = parseInt(url.searchParams.get("periodDays") || "30", 10);

    const metrics = await fraudAnalyticsService.getFraudRateMetrics(periodDays);

    json(res, 200, { data: metrics, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get fraud rate metrics";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/analytics/trends
 *
 * Get fraud trends
 */
export async function getFraudTrendsHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const periodDays = parseInt(url.searchParams.get("periodDays") || "90", 10);

    const trends = await fraudAnalyticsService.getFraudTrends(periodDays);

    json(res, 200, { data: trends, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get fraud trends";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}

/**
 * GET /api/v1/analytics/top-fraud-rules
 *
 * Get top fraud-triggering rules
 */
export async function getTopFraudRulesHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = extractAuth(req);
  if (!auth.userId) {
    unauthorized(res, "Authentication required", req);
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const limit = parseInt(url.searchParams.get("limit") || "10", 10);

    const rules = await fraudAnalyticsService.getTopFraudRules(limit);

    json(res, 200, { data: rules, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get top fraud rules";
    sendApiError(res, 500, "INTERNAL_ERROR", message, req);
  }
}
