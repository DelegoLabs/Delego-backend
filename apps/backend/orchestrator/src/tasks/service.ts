/**
 * @delegolabs/orchestrator — Human task service
 *
 * The service layer orchestrating the task lifecycle:
 *
 *   created -> assigned -> claimed -> in_progress -> completed | rejected
 *                          \-> escalated -> expired
 *
 * - `createTask` routes the task via a `TaskRoutingRule` (or a direct assignee).
 * - `claimTask` uses the store's atomic claim to prevent double-claiming.
 * - `completeTask` validates `formData` against `formSchema` (JSON Schema subset).
 * - Delegation records the handoff and re-targets the assignee.
 * - Bulk operations reuse the single-task mutations with an aggregator.
 *
 * Every mutation publishes a real-time event to the broker.
 */

import {
  TaskNotFoundError,
  TaskStateError,
  TaskValidationError,
  type CreateTaskInput,
  type HumanTask,
  type RoutingContext,
  type TaskComment,
  type TaskAttachment,
  type TaskStore,
} from "./types.js";
import { routeTask } from "./routing.js";
import type { TaskEventBroker } from "./subscriptions.js";

export { TaskNotFoundError, TaskStateError, TaskValidationError } from "./types.js";
export type { CreateTaskInput } from "./types.js";

export type TaskOperationInput = {
  actorId?: string;
  comment?: string;
};

export interface TaskServiceOptions {
  store: TaskStore;
  broker?: TaskEventBroker;
  /** Skills map for skill_based routing; fallback today: all candidates skilled. */
  skills?: Record<string, string[]>;
  /** Hook called whenever a task's status/assignee changes (optional). */
  onEvent?: (event: { type: string; task: HumanTask }) => void;
}

const OPEN_STATUSES = new Set(["created", "assigned", "claimed", "in_progress"]);

/**
 * Validates `formData` against a JSON Schema subset (type checks + required fields).
 * Only supports the subset of JSON Schema used for data-entry tasks. Returns a
 * normalized error message list, or an empty array when valid.
 */
export function validateFormData(
  formSchema: object | undefined,
  formData: Record<string, unknown> | undefined
): string[] {
  if (!formSchema) return [];
  const schema = formSchema as {
    required?: string[];
    properties?: Record<string, { type?: string; required?: boolean; minLength?: number }>;
  };
  const errors: string[] = [];
  if (schema.required && Array.isArray(schema.required)) {
    for (const key of schema.required) {
      const value = formData?.[key];
      if (value === undefined || value === null || value === "") {
        errors.push(`Missing required field: ${key}`);
      }
    }
  }
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const value = formData?.[key];
    if (value === undefined) continue;
    if (prop.type === "string" && typeof value !== "string") {
      errors.push(`Field "${key}" must be a string`);
    } else if (prop.type === "number" && typeof value !== "number") {
      errors.push(`Field "${key}" must be a number`);
    } else if (prop.type === "boolean" && typeof value !== "boolean") {
      errors.push(`Field "${key}" must be a boolean`);
    } else if (prop.type === "integer" && (typeof value !== "number" || !Number.isInteger(value))) {
      errors.push(`Field "${key}" must be an integer`);
    } else if (prop.type === "array" && !Array.isArray(value)) {
      errors.push(`Field "${key}" must be an array`);
    } else if (
      prop.type === "string" &&
      prop.minLength !== undefined &&
      typeof value === "string" &&
      value.length < prop.minLength
    ) {
      errors.push(`Field "${key}" must have at least ${prop.minLength} characters`);
    }
  }
  return errors;
}

export class TaskService {
  constructor(private readonly options: TaskServiceOptions) {}

  private get store(): TaskStore {
    return this.options.store;
  }

  /** Attach/replace the real-time event broker (e.g. once Redis is available). */
  setBroker(broker: TaskEventBroker | undefined): void {
    this.options.broker = broker;
  }

  private async emit(type: string, task: HumanTask): Promise<void> {
    this.options.onEvent?.({ type, task });
    if (this.options.broker) {
      await this.options.broker.publish({ type: type as never, task });
    }
  }

  private async requireTask(id: string): Promise<HumanTask> {
    const task = await this.store.get(id);
    if (!task) throw new TaskNotFoundError(`Task not found: ${id}`);
    return task;
  }

  private assertOpen(task: HumanTask, action: string): void {
    if (!OPEN_STATUSES.has(task.status) && task.status !== "escalated") {
      throw new TaskStateError(
        `Cannot ${action} task ${task.id}: current status "${task.status}" is not actionable`
      );
    }
  }

  private async buildRoutingContext(task: HumanTask): Promise<RoutingContext> {
    return {
      candidates: task.candidates,
      taskType: task.type,
      priority: task.priority,
      workflowType: task.workflowType,
      loadByAssignee: await this.store.countActiveByAssignee(),
      skills: (this.options.skills ?? {}) as RoutingContext["skills"],
    };
  }

  /**
   * Creates a task and routes it. When `input.assignee` is provided the task is
   * assigned directly; otherwise the routing rule for workflowType+type is resolved.
   * If no rule exists and candidates exist, the first candidate is assigned.
   */
  async createTask(input: CreateTaskInput): Promise<HumanTask> {
    if (!input.workflowId || !input.title || !input.type) {
      throw new TaskValidationError("workflowId, title and type are required");
    }
    const candidates = input.candidates ?? [];
    const directAssignee = input.assignee;
    const task = await this.store.create({
      ...input,
      candidates,
      assignee: directAssignee,
    });

    let assignee = directAssignee;
    if (!assignee) {
      const rule = await this.store.getRoutingRule(input.workflowType, input.type);
      if (rule) {
        const ctx = await this.buildRoutingContext(task);
        const result = routeTask(rule, ctx);
        assignee = result.assignee;
      } else if (candidates.length > 0) {
        assignee = candidates[0];
      }
    }

    if (assignee) {
      task.assignee = assignee;
      task.status = "assigned";
      task.assignedAt = new Date().toISOString();
      await this.store.update(task);
    }

    await this.emit("created", task);
    if (assignee) await this.emit("assigned", task);
    return task;
  }

  /** Explicitly (re)assigns an open task to a user (who must be a candidate unless it's an override). */
  async assignTask(id: string, assignee: string, actorId?: string): Promise<HumanTask> {
    if (!assignee || assignee.trim() === "") {
      throw new TaskValidationError("assignee is required");
    }
    const task = await this.requireTask(id);
    this.assertOpen(task, "assign");
    task.assignee = assignee;
    task.status = "assigned";
    task.assignedAt = task.assignedAt ?? new Date().toISOString();
    task.claimedAt = undefined;
    const updated = await this.store.update(task);
    await this.emit("assigned", updated);
    await this.addComment(id, actorId ?? "system", `Task assigned to ${assignee}`);
    return updated;
  }

  /** Claims an open task. Two operators cannot both claim it (atomic store claim). */
  async claimTask(id: string, assignee: string): Promise<HumanTask> {
    if (!assignee) throw new TaskValidationError("assignee is required");
    const task = await this.requireTask(id);
    if (task.assignee && task.assignee !== assignee) {
      throw new TaskStateError(`Task ${id} is assigned to ${task.assignee}, cannot be claimed by ${assignee}`);
    }
    const claimed = await this.store.claim(id, assignee);
    if (!claimed) {
      throw new TaskStateError(`Task ${id} could not be claimed (already claimed or no longer open)`);
    }
    await this.emit("claimed", claimed);
    return claimed;
  }

  /** Marks a claimed/assigned task as being actively worked. */
  async startTask(id: string, assignee: string): Promise<HumanTask> {
    const task = await this.requireTask(id);
    if (task.status !== "claimed" && task.status !== "assigned") {
      throw new TaskStateError(`Task ${id} must be claimed or assigned before starting`);
    }
    if (task.assignee && task.assignee !== assignee) {
      throw new TaskStateError(`Task ${id} is assigned to ${task.assignee}, cannot be started by ${assignee}`);
    }
    task.status = "in_progress";
    task.claimedAt = task.claimedAt ?? new Date().toISOString();
    this.assertOpen(task, "start");
    const updated = await this.store.update(task);
    await this.emit("started", updated);
    return updated;
  }

  /** Completes a task, validating form data if a schema is present. */
  async completeTask(id: string, input: { formData?: Record<string, unknown>; actorId?: string; comment?: string }): Promise<HumanTask> {
    const task = await this.requireTask(id);
    this.assertOpen(task, "complete");

    if (task.formSchema) {
      const errors = validateFormData(task.formSchema, input.formData);
      if (errors.length > 0) {
        throw new TaskValidationError(`Form validation failed: ${errors.join("; ")}`);
      }
    }

    task.status = "completed";
    task.completedAt = new Date().toISOString();
    task.formData = input.formData ?? task.formData;
    if (input.comment) {
      await this.addComment(id, input.actorId ?? "system", input.comment);
    }
    const updated = await this.store.update(task);
    await this.emit("completed", updated);
    return updated;
  }

  /** Rejects a task, optionally recording a reason as a comment. */
  async rejectTask(id: string, input: { reason?: string; actorId?: string }): Promise<HumanTask> {
    const task = await this.requireTask(id);
    this.assertOpen(task, "reject");
    task.status = "rejected";
    task.completedAt = new Date().toISOString();
    const updated = await this.store.update(task);
    await this.emit("rejected", updated);
    if (input.reason) {
      await this.addComment(id, input.actorId ?? "system", `Rejected: ${input.reason}`);
    }
    return updated;
  }

  /** Manually escalates an open task (marks it escalated, keeping it actionable). */
  async escalateTask(id: string, input: { reason?: string; actorId?: string }): Promise<HumanTask> {
    const task = await this.requireTask(id);
    this.assertOpen(task, "escalate");
    task.status = "escalated";
    const updated = await this.store.update(task);
    await this.emit("escalated", updated);
    if (input.reason) {
      await this.addComment(id, input.actorId ?? "system", `Escalated: ${input.reason}`);
    }
    return updated;
  }

  /** Delegates an open task from its current assignee to another user. */
  async delegateTask(id: string, toAssignee: string, input: { reason?: string; actorId?: string } = {}): Promise<HumanTask> {
    const task = await this.requireTask(id);
    this.assertOpen(task, "delegate");
    const from = task.assignee ?? "unassigned";
    task.assignee = toAssignee;
    task.status = "assigned";
    task.claimedAt = undefined;
    const updated = await this.store.update(task);
    await this.store.recordDelegation({
      taskId: id,
      fromAssignee: from,
      toAssignee,
      reason: input.reason,
    });
    await this.emit("delegated", updated);
    if (input.reason) {
      await this.addComment(id, input.actorId ?? "system", `Delegated from ${from} to ${toAssignee}: ${input.reason}`);
    }
    return updated;
  }

  async addComment(id: string, authorId: string, body: string): Promise<TaskComment> {
    if (!body || body.trim() === "") throw new TaskValidationError("comment body is required");
    await this.requireTask(id);
    const comment = await this.store.addComment({ taskId: id, authorId, body });
    const task = await this.requireTask(id);
    await this.emit("commented", task);
    return comment;
  }

  async listComments(id: string): Promise<TaskComment[]> {
    await this.requireTask(id);
    return this.store.listComments(id);
  }

  async addAttachment(
    id: string,
    input: { fileName: string; mimeType?: string; sizeBytes?: number; storageKey: string; uploadedBy: string }
  ): Promise<TaskAttachment> {
    await this.requireTask(id);
    if (!input.fileName || !input.storageKey) {
      throw new TaskValidationError("fileName and storageKey are required");
    }
    const attachment = await this.store.addAttachment({
      taskId: id,
      fileName: input.fileName,
      mimeType: input.mimeType ?? "application/octet-stream",
      sizeBytes: input.sizeBytes ?? 0,
      storageKey: input.storageKey,
      uploadedBy: input.uploadedBy,
    });
    const task = await this.requireTask(id);
    await this.emit("attached", task);
    return attachment;
  }

  async listAttachments(id: string): Promise<TaskAttachment[]> {
    await this.requireTask(id);
    return this.store.listAttachments(id);
  }

  async getTask(id: string): Promise<HumanTask> {
    return this.requireTask(id);
  }

  /** Inbox querying for the UI. */
  async listInbox(query: Parameters<TaskStore["listInbox"]>[0]) {
    return this.store.listInbox(query);
  }

  /** Performs the same operation across many task ids, aggregating successful/failed results. */
  async bulkOperation(
    operation: "assign" | "claim" | "complete" | "reject" | "escalate" | "delegate" | "start",
    ids: string[],
    payload: { assignee?: string; toAssignee?: string; formData?: Record<string, unknown>; reason?: string; actorId?: string } = {}
  ): Promise<{ succeeded: string[]; failed: Array<{ id: string; error: string }> }> {
    const succeeded: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of ids) {
      try {
        switch (operation) {
          case "assign":
            await this.assignTask(id, payload.assignee!, payload.actorId);
            break;
          case "claim":
            await this.claimTask(id, payload.assignee!);
            break;
          case "start":
            await this.startTask(id, payload.assignee!);
            break;
          case "complete":
            await this.completeTask(id, { formData: payload.formData, actorId: payload.actorId, comment: payload.reason });
            break;
          case "reject":
            await this.rejectTask(id, { reason: payload.reason, actorId: payload.actorId });
            break;
          case "escalate":
            await this.escalateTask(id, { reason: payload.reason, actorId: payload.actorId });
            break;
          case "delegate":
            await this.delegateTask(id, payload.toAssignee!, { reason: payload.reason, actorId: payload.actorId });
            break;
        }
        succeeded.push(id);
      } catch (err) {
        failed.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { succeeded, failed };
  }
}
