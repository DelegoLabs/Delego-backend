/**
 * @delegolabs/types — Human task management
 *
 * Shared domain types for tasks that require manual approval or intervention from a
 * human (an operator, reviewer, or approver) as part of a workflow. Human tasks are
 * created by workflows, routed to candidates, claimed and worked, tracked against an
 * SLA, and escalated when they breach it.
 */

export type HumanTaskType =
  | "approval"
  | "review"
  | "data_entry"
  | "verification"
  | "exception";

export type TaskPriority = "low" | "medium" | "high" | "urgent";

export type HumanTaskStatus =
  | "created"
  | "assigned"
  | "claimed"
  | "in_progress"
  | "completed"
  | "rejected"
  | "escalated"
  | "expired";

export interface HumanTask {
  id: string;
  workflowId: string;
  workflowType: string;
  type: HumanTaskType;
  title: string;
  description: string;
  priority: TaskPriority;
  assignee?: string;
  candidates: string[];
  status: HumanTaskStatus;
  formSchema?: object;
  formData?: Record<string, unknown>;
  slaHours: number;
  createdAt: string;
  assignedAt?: string;
  claimedAt?: string;
  completedAt?: string;
  dueAt: string;
}

export type RoutingStrategy =
  | "round_robin"
  | "least_loaded"
  | "skill_based"
  | "priority"
  | "specific_user";

export interface TaskRoutingRule {
  id: string;
  workflowType: string;
  taskType: string;
  strategy: RoutingStrategy;
  config: Record<string, unknown>;
  fallbackAssignee: string;
}

export interface TaskAssigneeMetrics {
  assigned: number;
  completed: number;
  avgTimeHours: number;
}

export interface TaskTypeMetrics {
  count: number;
  avgTimeHours: number;
}

export interface TaskMetrics {
  period: { start: string; end: string };
  totalTasks: number;
  completedTasks: number;
  avgCycleTimeHours: number;
  slaBreachRate: number;
  byAssignee: Record<string, TaskAssigneeMetrics>;
  byType: Record<string, TaskTypeMetrics>;
}

export interface TaskComment {
  id: string;
  taskId: string;
  authorId: string;
  body: string;
  createdAt: string;
}

export interface TaskAttachment {
  id: string;
  taskId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  uploadedBy: string;
  createdAt: string;
}
