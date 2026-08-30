/**
 * @delegolabs/orchestrator — Task routing
 *
 * Assigns a human task to a candidate based on a configured `TaskRoutingRule`
 * strategy:
 *
 * - `round_robin` — cycles through eligible candidates, distributing work evenly.
 * - `least_loaded` — picks the candidate with the fewest active (open) tasks.
 * - `skill_based` — picks from candidates who are configured (in `skills`) to work
 *   the task's type; falls back to all candidates.
 * - `priority` — candidates are assigned a weight per priority; chooses the highest
 *   weight candidate. Useful for routing urgent tasks to specialists.
 * - `specific_user` — always routes to the user named in `config.assignee`.
 *
 * Every strategy falls back to `rule.fallbackAssignee` when no candidate matches.
 */

import {
  TaskRoutingRuleError,
  type RoutingContext,
  type RoutingResult,
  type TaskPriority,
  type TaskRoutingRule,
} from "./types.js";

export function strategyLabel(strategy: TaskRoutingRule["strategy"]): string {
  return strategy;
}

function requireCandidates(rule: TaskRoutingRule, ctx: RoutingContext, context: string): string[] {
  const pool = ctx.candidates.filter((c) => c && c.trim() !== "");
  if (pool.length === 0) {
    throw new TaskRoutingRuleError(
      `routing (${rule.strategy}): no candidates supplied for ${context}`
    );
  }
  return pool;
}

/** Deterministically "hash" a string to a non-negative index (FNV-1a 32-bit). */
function hashIndex(seed: string, length: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % length;
}

function roundRobinAssign(rule: TaskRoutingRule, ctx: RoutingContext): string {
  const pool = requireCandidates(rule, ctx, ctx.taskType);
  const key = `${ctx.workflowType}:${ctx.taskType}`;
  const cursor = ctx.cursor ?? {};
  const idx = (cursor[key] ?? 0) % pool.length;
  if (ctx.cursor) cursor[key] = (idx + 1) % pool.length;
  return pool[idx];
}

function leastLoadedAssign(rule: TaskRoutingRule, ctx: RoutingContext): string {
  const pool = requireCandidates(rule, ctx, ctx.taskType);
  let best = pool[0];
  let bestLoad = Infinity;
  for (const candidate of pool) {
    const load = ctx.loadByAssignee[candidate] ?? 0;
    if (load < bestLoad) {
      bestLoad = load;
      best = candidate;
    }
  }
  return best;
}

function priorityOrder(priority: TaskPriority): number {
  switch (priority) {
    case "low":
      return 0;
    case "medium":
      return 1;
    case "high":
      return 2;
    case "urgent":
      return 3;
    default:
      return 1;
  }
}

function skillBasedAssign(rule: TaskRoutingRule, ctx: RoutingContext): string {
  const pool = requireCandidates(rule, ctx, ctx.taskType);
  const skills = ctx.skills ?? {};
  const skilled = pool.filter((c) => (skills[c] ?? []).includes(ctx.taskType));
  const eligible = skilled.length > 0 ? skilled : pool;
  const idx = rule.strategy === "skill_based" ? hashIndex(`${ctx.taskType}:${eligible.length}:${eligible[0]}`, eligible.length) : 0;
  // bias toward least-loaded among equals for balance
  let best = eligible[idx % eligible.length];
  let bestLoad = Infinity;
  for (const c of eligible) {
    const load = ctx.loadByAssignee[c] ?? 0;
    if (load < bestLoad) {
      bestLoad = load;
      best = c;
    }
  }
  return best;
}

function priorityAssign(rule: TaskRoutingRule, ctx: RoutingContext): string {
  const pool = requireCandidates(rule, ctx, ctx.taskType);
  const config = rule.config ?? {};
  const weights = config.weights as Record<string, number> | undefined;
  const requestedPriority = config.priority as TaskPriority | undefined;
  const effectivePriority = requestedPriority ?? ctx.priority;
  const rank = priorityOrder(effectivePriority);

  let best = pool[0];
  let bestWeight = -Infinity;
  for (const c of pool) {
    const w = weights?.[c] ?? 1;
    // On ties prefer lower load.
    const loadPenalty = ctx.loadByAssignee[c] ?? 0;
    const score = w * (rank + 1) - loadPenalty * 0.01;
    if (score > bestWeight) {
      bestWeight = score;
      best = c;
    }
  }
  return best;
}

function specificUserAssign(rule: TaskRoutingRule, ctx: RoutingContext): string {
  const target = (rule.config?.assignee as string | undefined) ?? "";
  if (target && (ctx.candidates.length === 0 || ctx.candidates.includes(target))) {
    return target;
  }
  if (target && !ctx.candidates.includes(target)) {
    throw new TaskRoutingRuleError(
      `routing (specific_user): assignee "${target}" is not a candidate for ${ctx.workflowType}/${ctx.taskType}`
    );
  }
  const pool = requireCandidates(rule, ctx, ctx.taskType);
  return pool[0];
}

/**
 * Resolves the chosen assignee for the given routing rule and context.
 * Returns the resolved assignee plus the strategy that was applied.
 * Throws `TaskRoutingRuleError` if the rule is invalid and there is no fallback.
 */
export function routeTask(rule: TaskRoutingRule, ctx: RoutingContext): RoutingResult {
  let assignee: string | null = null;
  let strategy = rule.strategy;

  try {
    switch (rule.strategy) {
      case "round_robin":
        assignee = roundRobinAssign(rule, ctx);
        break;
      case "least_loaded":
        assignee = leastLoadedAssign(rule, ctx);
        break;
      case "skill_based":
        assignee = skillBasedAssign(rule, ctx);
        break;
      case "priority":
        assignee = priorityAssign(rule, ctx);
        break;
      case "specific_user":
        assignee = specificUserAssign(rule, ctx);
        break;
      default:
        throw new TaskRoutingRuleError(`Unknown routing strategy: ${rule.strategy}`);
    }
  } catch (err) {
    if (rule.fallbackAssignee && rule.fallbackAssignee.trim() !== "") {
      if (!ctx.candidates.includes(rule.fallbackAssignee) && ctx.candidates.length > 0) {
        throw err;
      }
      return { assignee: rule.fallbackAssignee, strategy: `${rule.strategy}>fallback` as TaskRoutingRule["strategy"] };
    }
    throw err;
  }

  if (!assignee) {
    throw new TaskRoutingRuleError(`Routing strategy ${rule.strategy} returned no assignee`);
  }
  return { assignee, strategy };
}
