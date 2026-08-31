/**
 * @delegolabs/orchestrator — Human task HTTP routes
 *
 * Wiring for the orchestrator's HTTP server. All task endpoints follow the
 * `{ data, error }` envelope convention used across the service. The authenticated
 * user (`req.userId`, populated by `requireAuth`) is used as the default actor and
 * assignee for operations such as claim/complete.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json, PayloadTooLargeError, route, type Route } from "@delegolabs/utils";
import {
  TaskNotFoundError,
  TaskStateError,
  TaskValidationError,
  type CreateTaskInput,
  type TaskService,
} from "./service.js";
import { TaskRoutingRuleError } from "./types.js";
import { upsertRoutingRule, listRoutingRules } from "./index.js";
import type { TaskStore } from "./types.js";

const MAX_BODY_BYTES = Number(process.env.TASK_MAX_REQUEST_BODY_BYTES ?? 1_048_576);

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new PayloadTooLargeError(MAX_BODY_BYTES));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("JSON body must be an object");
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

type AuthRequest = IncomingMessage & { userId?: string };

function actorOf(req: IncomingMessage): string | undefined {
  return (req as AuthRequest).userId;
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof PayloadTooLargeError) {
    json(res, 413, { data: null, error: { code: "PAYLOAD_TOO_LARGE", message: err.message } });
    return;
  }
  if (err instanceof TaskNotFoundError) {
    json(res, 404, { data: null, error: { code: "TASK_NOT_FOUND", message: err.message } });
    return;
  }
  if (err instanceof TaskValidationError) {
    json(res, 400, { data: null, error: { code: "VALIDATION_ERROR", message: err.message } });
    return;
  }
  if (err instanceof TaskStateError) {
    json(res, 409, { data: null, error: { code: "TASK_STATE_CONFLICT", message: err.message } });
    return;
  }
  if (err instanceof TaskRoutingRuleError) {
    json(res, 400, { data: null, error: { code: "ROUTING_RULE_ERROR", message: err.message } });
    return;
  }
  json(res, 500, {
    data: null,
    error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Unknown error" },
  });
}

export function createTaskRoutes(service: TaskService, store: TaskStore): Route[] {
  const ensureTask = async (res: ServerResponse, op: (id: string, actorId?: string) => Promise<unknown>, id: string, actorId?: string) => {
    try {
      const data = await op(id, actorId);
      json(res, 200, { data, error: null });
    } catch (err) {
      sendError(res, err);
    }
  };

  return [
    // Create a task; routing happens server-side.
    route("POST", "/tasks", async (req, res) => {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendError(res, err);
        return;
      }
      try {
        const task = await service.createTask(body as unknown as CreateTaskInput);
        json(res, 201, { data: task, error: null });
      } catch (err) {
        sendError(res, err);
      }
    }),

    // Inbox / list
    route("GET", "/tasks", async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const actor = actorOf(req);
      const status = url.searchParams.get("status");
      const assignee = url.searchParams.get("assignee");
      const candidate = url.searchParams.get("candidate");
      const typeFilter = url.searchParams.get("type")?.split(",").filter(Boolean);
      const priority = url.searchParams.get("priority")?.split(",").filter(Boolean);
      const workflowType = url.searchParams.get("workflowType") ?? undefined;
      const mine = url.searchParams.get("mine") === "true";
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("offset") ?? 0);

      const result = await service.listInbox({
        assignee: assignee ?? (mine || (!assignee && !candidate && actor) ? actor : undefined),
        candidate: candidate ?? undefined,
        status: status ? [status as never] : undefined,
        types: typeFilter as never[] | undefined,
        priorities: priority as never[] | undefined,
        workflowType,
        limit: Number.isFinite(limit) ? limit : 50,
        offset: Number.isFinite(offset) ? offset : 0,
      });
      json(res, 200, { data: result, error: null });
    }),

    route("GET", "/tasks/:id", async (_req, res, params) => {
      try {
        const task = await service.getTask(params.id);
        const [{ comments, attachments }] = await Promise.all([
          Promise.all([service.listComments(params.id), service.listAttachments(params.id)]).then(
            ([comments, attachments]) => ({ comments, attachments })
          ),
        ]);
        json(res, 200, { data: { ...task, comments, attachments }, error: null });
      } catch (err) {
        sendError(res, err);
      }
    }),

    // Single-task lifecycle operations
    route("POST", "/tasks/:id/assign", async (req, res, params) => {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendError(res, err);
        return;
      }
      try {
        const task = await service.assignTask(params.id, String(body.assignee ?? ""), body.actorId != null ? String(body.actorId) : actorOf(req));
        json(res, 200, { data: task, error: null });
      } catch (err) {
        sendError(res, err);
      }
    }),

    route("POST", "/tasks/:id/claim", async (req, res, params) => {
      void ensureTask(res, (id) => service.claimTask(id, actorOf(req) ?? ""), params.id, actorOf(req));
    }),

    route("POST", "/tasks/:id/start", async (req, res, params) => {
      void ensureTask(res, (id, actor) => service.startTask(id, actor ?? ""), params.id, actorOf(req));
    }),

    route("POST", "/tasks/:id/complete", async (req, res, params) => {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendError(res, err);
        return;
      }
      try {
        const task = await service.completeTask(params.id, {
          formData: (body.formData as Record<string, unknown> | undefined) ?? {},
          actorId: body.actorId != null ? String(body.actorId) : actorOf(req),
          comment: body.comment != null ? String(body.comment) : undefined,
        });
        json(res, 200, { data: task, error: null });
      } catch (err) {
        sendError(res, err);
      }
    }),

    route("POST", "/tasks/:id/reject", async (req, res, params) => {
      try {
        const body = await readJsonBody(req).catch((): Record<string, unknown> => ({}));
        const task = await service.rejectTask(params.id, {
          reason: body.reason != null ? String(body.reason) : undefined,
          actorId: body.actorId != null ? String(body.actorId) : actorOf(req),
        });
        json(res, 200, { data: task, error: null });
      } catch (err) {
        sendError(res, err);
      }
    }),

    route("POST", "/tasks/:id/escalate", async (req, res, params) => {
      try {
        const body = await readJsonBody(req).catch((): Record<string, unknown> => ({}));
        const task = await service.escalateTask(params.id, {
          reason: body.reason != null ? String(body.reason) : undefined,
          actorId: body.actorId != null ? String(body.actorId) : actorOf(req),
        });
        json(res, 200, { data: task, error: null });
      } catch (err) {
        sendError(res, err);
      }
    }),

    route("POST", "/tasks/:id/delegate", async (req, res, params) => {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendError(res, err);
        return;
      }
      try {
        const task = await service.delegateTask(params.id, String(body.toAssignee ?? ""), {
          reason: body.reason != null ? String(body.reason) : undefined,
          actorId: body.actorId != null ? String(body.actorId) : actorOf(req),
        });
        json(res, 200, { data: task, error: null });
      } catch (err) {
        sendError(res, err);
      }
    }),

    // Comments
    route("POST", "/tasks/:id/comments", async (req, res, params) => {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendError(res, err);
        return;
      }
      try {
        const comment = await service.addComment(
          params.id,
          body.authorId != null ? String(body.authorId) : actorOf(req) ?? "system",
          String(body.body ?? "")
        );
        json(res, 201, { data: comment, error: null });
      } catch (err) {
        sendError(res, err);
      }
    }),

    route("GET", "/tasks/:id/comments", async (_req, res, params) => {
      try {
        const comments = await service.listComments(params.id);
        json(res, 200, { data: comments, error: null });
      } catch (err) {
        sendError(res, err);
      }
    }),

    // Attachments
    route("POST", "/tasks/:id/attachments", async (req, res, params) => {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendError(res, err);
        return;
      }
      try {
        const attachment = await service.addAttachment(params.id, {
          fileName: String(body.fileName ?? ""),
          mimeType: body.mimeType != null ? String(body.mimeType) : undefined,
          sizeBytes: body.sizeBytes != null ? Number(body.sizeBytes) : undefined,
          storageKey: String(body.storageKey ?? ""),
          uploadedBy: body.uploadedBy != null ? String(body.uploadedBy) : actorOf(req) ?? "system",
        });
        json(res, 201, { data: attachment, error: null });
      } catch (err) {
        sendError(res, err);
      }
    }),

    route("GET", "/tasks/:id/attachments", async (_req, res, params) => {
      try {
        const attachments = await service.listAttachments(params.id);
        json(res, 200, { data: attachments, error: null });
      } catch (err) {
        sendError(res, err);
      }
    }),

    // Bulk operations
    route("POST", "/tasks/bulk", async (req, res) => {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendError(res, err);
        return;
      }
      const operation = String(body.operation ?? "");
      const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).map(String) : [];
      if (!["assign", "claim", "complete", "reject", "escalate", "delegate", "start"].includes(operation) || ids.length === 0) {
        json(res, 400, {
          data: null,
          error: { code: "VALIDATION_ERROR", message: "operation and a non-empty ids array are required" },
        });
        return;
      }
      try {
        const payload = (body.payload ?? {}) as Record<string, unknown>;
        const result = await service.bulkOperation(operation as never, ids, {
          assignee: payload.assignee != null ? String(payload.assignee) : undefined,
          toAssignee: payload.toAssignee != null ? String(payload.toAssignee) : undefined,
          formData: (payload.formData as Record<string, unknown> | undefined) ?? undefined,
          reason: payload.reason != null ? String(payload.reason) : undefined,
          actorId: payload.actorId != null ? String(payload.actorId) : actorOf(req),
        });
        json(res, 200, { data: result, error: null });
      } catch (err) {
        sendError(res, err);
      }
    }),

    // Routing rules
    route("GET", "/tasks/routing-rules", async (_req, res) => {
      const rules = await listRoutingRules(store);
      json(res, 200, { data: rules, error: null });
    }),

    route("PUT", "/tasks/routing-rules", async (req, res) => {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendError(res, err);
        return;
      }
      try {
        const rule = await upsertRoutingRule(store, body as never);
        json(res, 200, { data: rule, error: null });
      } catch (err) {
        sendError(res, err);
      }
    }),

    // SLAs
    route("POST", "/tasks/sla/scan", async (_req, res) => {
      const { scanSla } = await import("./sla.js");
      const result = await scanSla(store);
      json(res, 200, { data: result, error: null });
    }),

    // Analytics
    route("GET", "/tasks/analytics", async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const start = url.searchParams.get("start");
      const end = url.searchParams.get("end");
      const { computeTaskMetrics } = await import("./analytics.js");
      const now = Date.now();
      const startDate = start ? new Date(start) : new Date(now - 7 * 24 * 3600_000);
      const endDate = end ? new Date(end) : new Date(now);
      const metrics = await computeTaskMetrics(store, { start: startDate, end: endDate });
      json(res, 200, { data: metrics, error: null });
    }),
  ];
}

