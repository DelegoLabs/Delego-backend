/**
 * @delegolabs/orchestrator — Postgres TaskStore
 *
 * Durable implementation of `TaskStore` backed by `human_tasks`,
 * `task_comments`, `task_attachments`, `task_routing_rules` and
 * `task_delegations` (see database/migrations/027_human_tasks.sql). Mirrors the
 * saga store's Sequelize + JSONB conventions.
 */

import { DataTypes, Model, Op, Optional, QueryTypes, Sequelize } from "sequelize";
import { createLogger } from "@delegolabs/utils";
import {
  type CreateTaskInput,
  type HumanTask,
  type HumanTaskStatus,
  type InboxQuery,
  type TaskAttachment,
  type TaskComment,
  type TaskRoutingRule,
  type TaskStore,
} from "./types.js";

const log = createLogger("orchestrator:tasks:store", process.env.LOG_LEVEL ?? "info");
const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego";

export const tasksSequelize = new Sequelize(databaseUrl, {
  dialect: "postgres",
  logging: (msg) => log.debug(msg),
  define: { underscored: true, timestamps: true },
});

interface HumanTaskAttributes {
  id: string;
  workflowId: string;
  workflowType: string;
  taskType: string;
  title: string;
  description: string;
  priority: string;
  assignee: string | null;
  candidates: string[];
  status: string;
  formSchema: object | null;
  formData: Record<string, unknown> | null;
  slaHours: number;
  assignedAt: Date | null;
  claimedAt: Date | null;
  completedAt: Date | null;
  dueAt: Date;
}

class HumanTaskModel extends Model<HumanTaskAttributes> implements HumanTaskAttributes {
  declare id: string;
  declare workflowId: string;
  declare workflowType: string;
  declare taskType: string;
  declare title: string;
  declare description: string;
  declare priority: string;
  declare assignee: string | null;
  declare candidates: string[];
  declare status: string;
  declare formSchema: object | null;
  declare formData: Record<string, unknown> | null;
  declare slaHours: number;
  declare createdAt: Date;
  declare assignedAt: Date | null;
  declare claimedAt: Date | null;
  declare completedAt: Date | null;
  declare dueAt: Date;
  declare updatedAt: Date;
}

HumanTaskModel.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true },
    workflowId: { type: DataTypes.STRING(128), allowNull: false, field: "workflow_id" },
    workflowType: { type: DataTypes.STRING(64), allowNull: false, field: "workflow_type" },
    taskType: { type: DataTypes.STRING(32), allowNull: false, field: "task_type" },
    title: { type: DataTypes.STRING(255), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    priority: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "medium" },
    assignee: { type: DataTypes.STRING(128), allowNull: true },
    candidates: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "created" },
    formSchema: { type: DataTypes.JSONB, allowNull: true, field: "form_schema" },
    formData: { type: DataTypes.JSONB, allowNull: true, field: "form_data" },
    slaHours: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 24, field: "sla_hours" },
    assignedAt: { type: DataTypes.DATE, allowNull: true, field: "assigned_at" },
    claimedAt: { type: DataTypes.DATE, allowNull: true, field: "claimed_at" },
    completedAt: { type: DataTypes.DATE, allowNull: true, field: "completed_at" },
    dueAt: { type: DataTypes.DATE, allowNull: false, field: "due_at" },
  },
  { sequelize: tasksSequelize, modelName: "HumanTask", tableName: "human_tasks" }
);

interface TaskCommentAttributes {
  id: string;
  taskId: string;
  authorId: string;
  body: string;
}
class TaskCommentModel extends Model<TaskCommentAttributes, Optional<TaskCommentAttributes, "id">>
  implements TaskCommentAttributes {
  declare id: string;
  declare taskId: string;
  declare authorId: string;
  declare body: string;
  declare readonly createdAt: Date;
}
TaskCommentModel.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true },
    taskId: { type: DataTypes.UUID, allowNull: false, field: "task_id" },
    authorId: { type: DataTypes.STRING(128), allowNull: false, field: "author_id" },
    body: { type: DataTypes.TEXT, allowNull: false },
  },
  { sequelize: tasksSequelize, modelName: "TaskComment", tableName: "task_comments", updatedAt: false }
);

interface TaskAttachmentAttributes {
  id: string;
  taskId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  uploadedBy: string;
}
class TaskAttachmentModel
  extends Model<TaskAttachmentAttributes, Optional<TaskAttachmentAttributes, "id">>
  implements TaskAttachmentAttributes {
  declare id: string;
  declare taskId: string;
  declare fileName: string;
  declare mimeType: string;
  declare sizeBytes: number;
  declare storageKey: string;
  declare uploadedBy: string;
  declare readonly createdAt: Date;
}
TaskAttachmentModel.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true },
    taskId: { type: DataTypes.UUID, allowNull: false, field: "task_id" },
    fileName: { type: DataTypes.STRING(512), allowNull: false, field: "file_name" },
    mimeType: { type: DataTypes.STRING(128), allowNull: false, defaultValue: "application/octet-stream", field: "mime_type" },
    sizeBytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: "size_bytes" },
    storageKey: { type: DataTypes.STRING(1024), allowNull: false, field: "storage_key" },
    uploadedBy: { type: DataTypes.STRING(128), allowNull: false, field: "uploaded_by" },
  },
  { sequelize: tasksSequelize, modelName: "TaskAttachment", tableName: "task_attachments", updatedAt: false }
);

interface RoutingRuleAttributes {
  id: string;
  workflowType: string;
  taskType: string;
  strategy: string;
  config: Record<string, unknown>;
  fallbackAssignee: string;
}
class RoutingRuleModel extends Model<RoutingRuleAttributes> implements RoutingRuleAttributes {
  declare id: string;
  declare workflowType: string;
  declare taskType: string;
  declare strategy: string;
  declare config: Record<string, unknown>;
  declare fallbackAssignee: string;
  declare createdAt: Date;
  declare updatedAt: Date;
}
RoutingRuleModel.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true },
    workflowType: { type: DataTypes.STRING(64), allowNull: false, field: "workflow_type" },
    taskType: { type: DataTypes.STRING(32), allowNull: false, field: "task_type" },
    strategy: { type: DataTypes.STRING(32), allowNull: false },
    config: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    fallbackAssignee: { type: DataTypes.STRING(128), allowNull: false, defaultValue: "", field: "fallback_assignee" },
  },
  { sequelize: tasksSequelize, modelName: "TaskRoutingRule", tableName: "task_routing_rules" }
);

function toTask(row: HumanTaskModel): HumanTask {
  return {
    id: row.id,
    workflowId: row.workflowId,
    workflowType: row.workflowType,
    type: row.taskType as HumanTask["type"],
    title: row.title,
    description: row.description,
    priority: row.priority as HumanTask["priority"],
    assignee: row.assignee ?? undefined,
    candidates: row.candidates ?? [],
    status: row.status as HumanTaskStatus,
    formSchema: row.formSchema ?? undefined,
    formData: row.formData ?? undefined,
    slaHours: Number(row.slaHours),
    createdAt: row.createdAt.toISOString(),
    assignedAt: row.assignedAt?.toISOString(),
    claimedAt: row.claimedAt?.toISOString(),
    completedAt: row.completedAt?.toISOString(),
    dueAt: row.dueAt.toISOString(),
  };
}

export class PostgresTaskStore implements TaskStore {
  async create(input: CreateTaskInput): Promise<HumanTask> {
    const slaHours = input.slaHours ?? 24;
    const now = new Date();
    const dueAt = new Date(now.getTime() + slaHours * 3600_000);
    const row = await HumanTaskModel.create({
      id: crypto.randomUUID(),
      workflowId: input.workflowId,
      workflowType: input.workflowType,
      taskType: input.type,
      title: input.title,
      description: input.description ?? "",
      priority: input.priority ?? "medium",
      assignee: input.assignee ?? null,
      candidates: input.candidates ?? [],
      status: input.assignee ? "assigned" : "created",
      formSchema: input.formSchema ?? null,
      formData: input.formData ?? null,
      slaHours,
      assignedAt: input.assignee ? now : null,
      claimedAt: null,
      completedAt: null,
      dueAt,
    });
    return toTask(row);
  }

  async get(id: string): Promise<HumanTask | null> {
    const row = await HumanTaskModel.findByPk(id);
    return row ? toTask(row) : null;
  }

  async update(task: HumanTask): Promise<HumanTask> {
    await HumanTaskModel.update(
      {
        workflowType: task.workflowType,
        taskType: task.type,
        title: task.title,
        description: task.description,
        priority: task.priority,
        assignee: task.assignee ?? null,
        candidates: task.candidates,
        status: task.status,
        formSchema: task.formSchema ?? null,
        formData: task.formData ?? null,
        assignedAt: task.assignedAt ? new Date(task.assignedAt) : null,
        claimedAt: task.claimedAt ? new Date(task.claimedAt) : null,
        completedAt: task.completedAt ? new Date(task.completedAt) : null,
      },
      { where: { id: task.id } }
    );
    return (await this.get(task.id))!;
  }

  async claim(taskId: string, assignee: string): Promise<HumanTask | null> {
    const row = await HumanTaskModel.findOne({
      where: {
        id: taskId,
        assignee,
        status: { [Op.in]: ["assigned", "created"] },
      },
    });
    if (!row) return null;
    const now = new Date();
    row.status = "claimed";
    row.claimedAt = now;
    row.assignedAt = row.assignedAt ?? now;
    await row.save();
    return toTask(row);
  }

  async addComment(input: { taskId: string; authorId: string; body: string }): Promise<TaskComment> {
    const task = await HumanTaskModel.findByPk(input.taskId);
    if (!task) throw new Error(`Task not found: ${input.taskId}`);
    const row = await TaskCommentModel.create({
      id: crypto.randomUUID(),
      taskId: input.taskId,
      authorId: input.authorId,
      body: input.body,
    });
    return { id: row.id, taskId: row.taskId, authorId: row.authorId, body: row.body, createdAt: row.createdAt.toISOString() };
  }

  async listComments(taskId: string): Promise<TaskComment[]> {
    const rows = await TaskCommentModel.findAll({ where: { taskId }, order: [["created_at", "ASC"]] });
    return rows.map((r) => ({ id: r.id, taskId: r.taskId, authorId: r.authorId, body: r.body, createdAt: r.createdAt.toISOString() }));
  }

  async addAttachment(input: {
    taskId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    storageKey: string;
    uploadedBy: string;
  }): Promise<TaskAttachment> {
    const task = await HumanTaskModel.findByPk(input.taskId);
    if (!task) throw new Error(`Task not found: ${input.taskId}`);
    const row = await TaskAttachmentModel.create({
      id: crypto.randomUUID(),
      taskId: input.taskId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      storageKey: input.storageKey,
      uploadedBy: input.uploadedBy,
    });
    return {
      id: row.id,
      taskId: row.taskId,
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: Number(row.sizeBytes),
      storageKey: row.storageKey,
      uploadedBy: row.uploadedBy,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listAttachments(taskId: string): Promise<TaskAttachment[]> {
    const rows = await TaskAttachmentModel.findAll({ where: { taskId }, order: [["created_at", "ASC"]] });
    return rows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      fileName: r.fileName,
      mimeType: r.mimeType,
      sizeBytes: Number(r.sizeBytes),
      storageKey: r.storageKey,
      uploadedBy: r.uploadedBy,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async listRoutingRules(): Promise<TaskRoutingRule[]> {
    const rows = await RoutingRuleModel.findAll();
    return rows.map((r) => ({
      id: r.id,
      workflowType: r.workflowType,
      taskType: r.taskType,
      strategy: r.strategy as TaskRoutingRule["strategy"],
      config: r.config,
      fallbackAssignee: r.fallbackAssignee,
    }));
  }

  async getRoutingRule(workflowType: string, taskType: string): Promise<TaskRoutingRule | null> {
    const row = await RoutingRuleModel.findOne({ where: { workflowType, taskType } });
    if (!row) return null;
    return {
      id: row.id,
      workflowType: row.workflowType,
      taskType: row.taskType,
      strategy: row.strategy as TaskRoutingRule["strategy"],
      config: row.config,
      fallbackAssignee: row.fallbackAssignee,
    };
  }

  async upsertRoutingRule(rule: TaskRoutingRule): Promise<TaskRoutingRule> {
    const [row] = await RoutingRuleModel.findOrCreate({
      where: { workflowType: rule.workflowType, taskType: rule.taskType },
      defaults: {
        id: rule.id,
        workflowType: rule.workflowType,
        taskType: rule.taskType,
        strategy: rule.strategy,
        config: rule.config,
        fallbackAssignee: rule.fallbackAssignee,
      },
    });
    row.strategy = rule.strategy;
    row.config = rule.config;
    row.fallbackAssignee = rule.fallbackAssignee;
    await row.save();
    return {
      id: row.id,
      workflowType: row.workflowType,
      taskType: row.taskType,
      strategy: row.strategy as TaskRoutingRule["strategy"],
      config: row.config,
      fallbackAssignee: row.fallbackAssignee,
    };
  }

  async listInbox(query: InboxQuery): Promise<{ tasks: HumanTask[]; total: number }> {
    const where: Record<string, unknown> = {};
    if (query.assignee) where.assignee = query.assignee;
    if (query.candidate) where.candidates = { [Op.contains]: [query.candidate] };
    if (query.status?.length) where.status = { [Op.in]: query.status };
    if (query.types?.length) where.taskType = { [Op.in]: query.types };
    if (query.priorities?.length) where.priority = { [Op.in]: query.priorities };
    if (query.workflowType) where.workflowType = query.workflowType;
    const due: Array<Record<string, unknown>> = [];
    if (query.dueBefore) due.push({ due_at: { [Op.lte]: query.dueBefore } });
    if (query.dueAfter) due.push({ due_at: { [Op.gte]: query.dueAfter } });
    if (due.length) (where as Record<string | symbol, unknown>)[Op.and] = due as never;

    const total = await HumanTaskModel.count({ where: where as never });
    const rows = await HumanTaskModel.findAll({
      where: where as never,
      order: [["created_at", "ASC"]],
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
    return { tasks: rows.map(toTask), total };
  }

  async listForSlaScan(_now: Date): Promise<HumanTask[]> {
    const rows = await HumanTaskModel.findAll({
      where: { status: { [Op.in]: ["created", "assigned", "claimed", "in_progress", "escalated"] } },
    });
    return rows.map(toTask);
  }

  async recordDelegation(input: { taskId: string; fromAssignee: string; toAssignee: string; reason?: string }): Promise<void> {
    // task_delegations has no Sequelize model; run raw insert via the shared sequelize.
    await tasksSequelize.query(
      `INSERT INTO task_delegations (id, task_id, from_assignee, to_assignee, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      {
        bind: [crypto.randomUUID(), input.taskId, input.fromAssignee, input.toAssignee, input.reason ?? null],
      }
    );
  }

  async countActiveByAssignee(): Promise<Record<string, number>> {
    const result = await tasksSequelize.query<{ assignee: string; n: string }>(
      `SELECT assignee, COUNT(*)::text AS n FROM human_tasks
       WHERE assignee IS NOT NULL AND status NOT IN ('completed', 'rejected', 'expired')
       GROUP BY assignee`,
      { type: QueryTypes.SELECT }
    );
    const counts: Record<string, number> = {};
    for (const r of result) counts[r.assignee] = Number(r.n);
    return counts;
  }

  async listCompletedBetween(start: Date, end: Date): Promise<HumanTask[]> {
    const rows = await HumanTaskModel.findAll({
      where: { completedAt: { [Op.between]: [start, end] } } as never,
    });
    return rows.map(toTask);
  }

  async listCreatedBetween(start: Date, end: Date): Promise<HumanTask[]> {
    const rows = await HumanTaskModel.findAll({
      where: { createdAt: { [Op.between]: [start, end] } } as never,
    });
    return rows.map(toTask);
  }
}
