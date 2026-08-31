/**
 * @delegolabs/orchestrator — Human task management public entrypoint.
 *
 * Export the service, store, routing, SLA, analytics, subscriptions and error types.
 */

export { TaskService } from "./service.js";
export {
  validateFormData,
  TaskNotFoundError,
  TaskStateError,
  TaskValidationError,
  type TaskServiceOptions,
  type TaskOperationInput,
  type CreateTaskInput,
} from "./service.js";

export { InMemoryTaskStore } from "./memory-store.js";
export { PostgresTaskStore, tasksSequelize } from "./postgres-store.js";

export { routeTask, strategyLabel } from "./routing.js";
export { scanSla, slaStatus, type SlaScanResult } from "./sla.js";
export { computeTaskMetrics } from "./analytics.js";
export { TaskEventBroker, type TaskEvent, type TaskEventType, type PubSubClient } from "./subscriptions.js";

export {
  TaskConflictError,
  TaskRoutingRuleError,
  type TaskStore,
  type InboxQuery,
  type RoutingContext,
  type RoutingResult,
  type TaskUpdate,
} from "./types.js";
export type {
  HumanTask,
  HumanTaskStatus,
  HumanTaskType,
  TaskPriority,
  TaskRoutingRule,
  RoutingStrategy,
  TaskComment,
  TaskAttachment,
  TaskMetrics,
  TaskAssigneeMetrics,
  TaskTypeMetrics,
} from "@delegolabs/types";

import { TaskRoutingRuleError, type TaskRoutingRule, type TaskStore } from "./types.js";
import { randomUUID } from "node:crypto";

const ROUTING_STRATEGIES = ["round_robin", "least_loaded", "skill_based", "priority", "specific_user"] as const;

/**
 * Validates and upserts a routing rule for a workflow+task type. Rule ids are
 * generated on create. Throws `TaskRoutingRuleError` on invalid input.
 */
export async function upsertRoutingRule(
  store: TaskStore,
  input: Partial<TaskRoutingRule> & { workflowType: string; taskType: string; strategy: TaskRoutingRule["strategy"] }
): Promise<TaskRoutingRule> {
  if (!input.workflowType || !input.taskType || !input.strategy) {
    throw new TaskRoutingRuleError("workflowType, taskType and strategy are required");
  }
  if (!ROUTING_STRATEGIES.includes(input.strategy as (typeof ROUTING_STRATEGIES)[number])) {
    throw new TaskRoutingRuleError(`Unknown routing strategy: ${input.strategy}`);
  }
  const rule: TaskRoutingRule = {
    id: input.id ?? randomUUID(),
    workflowType: input.workflowType,
    taskType: input.taskType,
    strategy: input.strategy,
    config: input.config ?? {},
    fallbackAssignee: input.fallbackAssignee ?? "",
  };
  return store.upsertRoutingRule(rule);
}

export async function listRoutingRules(store: TaskStore): Promise<TaskRoutingRule[]> {
  return store.listRoutingRules();
}
