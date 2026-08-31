/**
 * @delegolabs/orchestrator — Human task management internals
 *
 * Local types for the human task module. Re-exports the shared domain types from
 * `@delegolabs/types` and adds the persistence boundaries (store interfaces) used by
 * the service, routing, SLA and analytics layers.
 */

import type {
  HumanTask,
  HumanTaskStatus,
  HumanTaskType,
  TaskPriority,
  TaskRoutingRule,
  RoutingStrategy,
  TaskComment,
  TaskAttachment,
} from "@delegolabs/types";

export type {
  HumanTask,
  HumanTaskStatus,
  HumanTaskType,
  TaskPriority,
  TaskRoutingRule,
  RoutingStrategy,
  TaskComment,
  TaskAttachment,
} from "@delegolabs/types";

export interface CreateTaskInput {
  workflowId: string;
  workflowType: string;
  type: HumanTaskType;
  title: string;
  description?: string;
  priority?: TaskPriority;
  candidates?: string[];
  assignee?: string;
  formSchema?: object;
  formData?: Record<string, unknown>;
  slaHours?: number;
}

export interface TaskUpdate {
  assignee?: string;
  claimer?: string;
  status?: HumanTaskStatus;
  assign(a: string): void;
}

/** Storage backend shared by service, routing, SLA and analytics. */
export interface TaskStore {
  create(input: CreateTaskInput): Promise<HumanTask>;
  get(id: string): Promise<HumanTask | null>;
  update(task: HumanTask): Promise<HumanTask>;
  /**
   * Atomically claim a task owned by `assignee` with status `claimed`. Returns the
   * updated task or `null` if the precondition (task exists, assignee matches,
   * status is claimable) no longer holds — used to prevent two operators claiming
   * the same task.
   */
  claim(taskId: string, assignee: string): Promise<HumanTask | null>;
  /**
   * Atomically append a comment and return it. Backed by the same store so a single
   * implementation owns the table.
   */
  addComment(input: {
    taskId: string;
    authorId: string;
    body: string;
  }): Promise<TaskComment>;
  listComments(taskId: string): Promise<TaskComment[]>;
  addAttachment(input: {
    taskId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    storageKey: string;
    uploadedBy: string;
  }): Promise<TaskAttachment>;
  listAttachments(taskId: string): Promise<TaskAttachment[]>;
  listRoutingRules(): Promise<TaskRoutingRule[]>;
  getRoutingRule(workflowType: string, taskType: string): Promise<TaskRoutingRule | null>;
  upsertRoutingRule(rule: TaskRoutingRule): Promise<TaskRoutingRule>;
  listInbox(query: InboxQuery): Promise<{ tasks: HumanTask[]; total: number }>;
  listForSlaScan(now: Date): Promise<HumanTask[]>;
  recordDelegation(input: {
    taskId: string;
    fromAssignee: string;
    toAssignee: string;
    reason?: string;
  }): Promise<void>;
  countActiveByAssignee(): Promise<Record<string, number>>;
  listCompletedBetween(start: Date, end: Date): Promise<HumanTask[]>;
  listCreatedBetween(start: Date, end: Date): Promise<HumanTask[]>;
}

export interface InboxQuery {
  assignee?: string;
  candidate?: string;
  status?: HumanTaskStatus[];
  types?: HumanTaskType[];
  priorities?: TaskPriority[];
  workflowType?: string;
  dueBefore?: Date;
  dueAfter?: Date;
  limit?: number;
  offset?: number;
}

/** Candidate resolution context for routing strategies. */
export interface RoutingContext {
  candidates: string[];
  taskType: HumanTaskType;
  priority: TaskPriority;
  workflowType: string;
  /** Active (open) tasks per assignee, used by least_loaded. */
  loadByAssignee: Record<string, number>;
  /** Round-robin cursor keyed by workflowType+taskType. Maintained in-memory. */
  cursor?: Record<string, number>;
  /** Skill map for skill_based routing: assignee -> set of task types they can work. */
  skills?: Record<string, HumanTaskType[]>;
}

export interface RoutingResult {
  assignee: string;
  strategy: RoutingStrategy;
}

export class TaskValidationError extends Error {}
export class TaskNotFoundError extends Error {}
export class TaskStateError extends Error {}
export class TaskConflictError extends Error {}
export class TaskRoutingRuleError extends Error {}
