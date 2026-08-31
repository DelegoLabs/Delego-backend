/**
 * @delegolabs/orchestrator — In-memory TaskStore
 *
 * Reference implementation used by unit tests (no PostgreSQL required) and as a
 * default backing store. Mirrors the Postgres round-trip semantics including the
 * atomic `claim` precondition.
 */

import { randomUUID } from "node:crypto";
import {
  type CreateTaskInput,
  type HumanTask,
  type InboxQuery,
  type TaskAttachment,
  type TaskComment,
  type TaskRoutingRule,
  type TaskStore,
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

export class InMemoryTaskStore implements TaskStore {
  private tasks = new Map<string, HumanTask>();
  private comments = new Map<string, TaskComment[]>();
  private attachments = new Map<string, TaskAttachment[]>();
  private routingRules = new Map<string, TaskRoutingRule>();
  private delegations: Array<{ taskId: string; fromAssignee: string; toAssignee: string; reason?: string }> = [];

  async create(input: CreateTaskInput): Promise<HumanTask> {
    const now = nowIso();
    const nowMs = Date.now();
    const slaHours = input.slaHours ?? 24;
    const task: HumanTask = {
      id: randomUUID(),
      workflowId: input.workflowId,
      workflowType: input.workflowType,
      type: input.type,
      title: input.title,
      description: input.description ?? "",
      priority: input.priority ?? "medium",
      assignee: input.assignee,
      candidates: input.candidates ?? [],
      status: input.assignee ? "assigned" : "created",
      formSchema: input.formSchema,
      formData: input.formData,
      slaHours,
      createdAt: now,
      assignedAt: input.assignee ? now : undefined,
      dueAt: new Date(nowMs + slaHours * 3600_000).toISOString(),
    };
    this.tasks.set(task.id, task);
    this.comments.set(task.id, []);
    this.attachments.set(task.id, []);
    return structuredClone(task);
  }

  async get(id: string): Promise<HumanTask | null> {
    const task = this.tasks.get(id);
    return task ? structuredClone(task) : null;
  }

  async update(task: HumanTask): Promise<HumanTask> {
    if (!this.tasks.has(task.id)) throw new Error(`Task not found: ${task.id}`);
    this.tasks.set(task.id, structuredClone(task));
    const updated = await this.get(task.id);
    return updated!;
  }

  async claim(taskId: string, assignee: string): Promise<HumanTask | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (task.assignee !== assignee) return null;
    if (task.status !== "assigned" && task.status !== "created") return null;
    const now = nowIso();
    this.tasks.set(taskId, {
      ...task,
      status: "claimed",
      assignee,
      claimedAt: now,
      assignedAt: task.assignedAt ?? now,
    });
    const claimed = await this.get(taskId);
    return claimed;
  }

  async addComment(input: { taskId: string; authorId: string; body: string }): Promise<TaskComment> {
    if (!this.tasks.has(input.taskId)) throw new Error(`Task not found: ${input.taskId}`);
    const comment: TaskComment = {
      id: randomUUID(),
      taskId: input.taskId,
      authorId: input.authorId,
      body: input.body,
      createdAt: nowIso(),
    };
    const list = this.comments.get(input.taskId) ?? [];
    list.push(comment);
    this.comments.set(input.taskId, list);
    return structuredClone(comment);
  }

  async listComments(taskId: string): Promise<TaskComment[]> {
    return structuredClone(this.comments.get(taskId) ?? []);
  }

  async addAttachment(input: {
    taskId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    storageKey: string;
    uploadedBy: string;
  }): Promise<TaskAttachment> {
    if (!this.tasks.has(input.taskId)) throw new Error(`Task not found: ${input.taskId}`);
    const attachment: TaskAttachment = {
      id: randomUUID(),
      taskId: input.taskId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      storageKey: input.storageKey,
      uploadedBy: input.uploadedBy,
      createdAt: nowIso(),
    };
    const list = this.attachments.get(input.taskId) ?? [];
    list.push(attachment);
    this.attachments.set(input.taskId, list);
    return structuredClone(attachment);
  }

  async listAttachments(taskId: string): Promise<TaskAttachment[]> {
    return structuredClone(this.attachments.get(taskId) ?? []);
  }

  async listRoutingRules(): Promise<TaskRoutingRule[]> {
    return structuredClone([...this.routingRules.values()]);
  }

  async getRoutingRule(workflowType: string, taskType: string): Promise<TaskRoutingRule | null> {
    const rule = this.routingRules.get(`${workflowType}:${taskType}`);
    return rule ? structuredClone(rule) : null;
  }

  async upsertRoutingRule(rule: TaskRoutingRule): Promise<TaskRoutingRule> {
    this.routingRules.set(`${rule.workflowType}:${rule.taskType}`, structuredClone(rule));
    const saved = await this.getRoutingRule(rule.workflowType, rule.taskType);
    return saved!;
  }

  async listInbox(query: InboxQuery): Promise<{ tasks: HumanTask[]; total: number }> {
    let tasks = [...this.tasks.values()];
    if (query.assignee) tasks = tasks.filter((t) => t.assignee === query.assignee);
    if (query.candidate) tasks = tasks.filter((t) => t.candidates.includes(query.candidate!));
    if (query.status?.length) tasks = tasks.filter((t) => query.status!.includes(t.status));
    if (query.types?.length) tasks = tasks.filter((t) => query.types!.includes(t.type));
    if (query.priorities?.length) tasks = tasks.filter((t) => query.priorities!.includes(t.priority));
    if (query.workflowType) tasks = tasks.filter((t) => t.workflowType === query.workflowType);
    if (query.dueBefore) tasks = tasks.filter((t) => new Date(t.dueAt).getTime() <= query.dueBefore!.getTime());
    if (query.dueAfter) tasks = tasks.filter((t) => new Date(t.dueAt).getTime() >= query.dueAfter!.getTime());
    tasks.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const total = tasks.length;
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    return { tasks: structuredClone(tasks.slice(offset, offset + limit)), total };
  }

  async listForSlaScan(_now: Date): Promise<HumanTask[]> {
    return structuredClone(
      [...this.tasks.values()].filter((t) =>
        ["created", "assigned", "claimed", "in_progress", "escalated"].includes(t.status)
      )
    );
  }

  async recordDelegation(input: { taskId: string; fromAssignee: string; toAssignee: string; reason?: string }): Promise<void> {
    this.delegations.push(input);
  }

  async countActiveByAssignee(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const t of this.tasks.values()) {
      if (!t.assignee) continue;
      if (!["completed", "rejected", "expired"].includes(t.status)) {
        counts[t.assignee] = (counts[t.assignee] ?? 0) + 1;
      }
    }
    return counts;
  }

  async listCompletedBetween(start: Date, end: Date): Promise<HumanTask[]> {
    return structuredClone(
      [...this.tasks.values()].filter((t) => {
        if (!t.completedAt) return false;
        const ts = new Date(t.completedAt).getTime();
        return ts >= start.getTime() && ts <= end.getTime();
      })
    );
  }

  async listCreatedBetween(start: Date, end: Date): Promise<HumanTask[]> {
    return structuredClone(
      [...this.tasks.values()].filter((t) => {
        const ts = new Date(t.createdAt).getTime();
        return ts >= start.getTime() && ts <= end.getTime();
      })
    );
  }
}
