/**
 * Issue #148 — Automated reconciliation rules engine.
 *
 * Evaluates reconciliation rules against matched records and determines
 * the appropriate action: auto_match, auto_resolve, flag_review, or escalate.
 */

import { createLogger } from "@delegolabs/utils";
import type {
  ReconciliationRule,
  RuleEvaluationContext,
  SettlementMatch,
  SettlementRecord,
  ExternalSettlementRecord,
  ReconciliationAuditEntry,
} from "./enhancedTypes.js";

const log = createLogger("payments:reconciliation-rules", process.env.LOG_LEVEL ?? "info");

// ─── Default Rules ────────────────────────────────────────────────────────────

export const DEFAULT_RULES: ReconciliationRule[] = [
  {
    id: "exact_match_auto",
    name: "Auto-match exact matches",
    condition: "match.matchScore === 1 && match.discrepancies.length === 0",
    action: "auto_match",
    priority: 1,
    config: {},
    enabled: true,
  },
  {
    id: "high_confidence_auto",
    name: "Auto-resolve high-confidence fuzzy matches",
    condition: "match.matchScore >= 0.95 && match.discrepancies.every(d => d.severity === 'minor')",
    action: "auto_resolve",
    priority: 2,
    config: {},
    enabled: true,
  },
  {
    id: "medium_confidence_review",
    name: "Flag medium-confidence matches for review",
    condition: "match.matchScore >= 0.80 && match.matchScore < 0.95",
    action: "flag_review",
    priority: 3,
    config: {},
    enabled: true,
  },
  {
    id: "low_confidence_escalate",
    name: "Escalate low-confidence matches",
    condition: "match.matchScore < 0.80",
    action: "escalate",
    priority: 4,
    config: {},
    enabled: true,
  },
  {
    id: "critical_discrepancy_escalate",
    name: "Escalate critical discrepancies immediately",
    condition: "match.discrepancies.some(d => d.severity === 'critical')",
    action: "escalate",
    priority: 0, // Highest priority
    config: {},
    enabled: true,
  },
  {
    id: "large_amount_review",
    name: "Flag large amounts for manual review",
    condition: "parseFloat(internalRecord.amount) > 1000000000", // > 100 XLM in stroops
    action: "flag_review",
    priority: 5,
    config: { threshold: "1000000000" },
    enabled: true,
  },
];

// ─── Rule Engine ──────────────────────────────────────────────────────────────

export type RuleAction = "auto_match" | "auto_resolve" | "flag_review" | "escalate";

export interface RuleEvaluationResult {
  ruleId: string;
  ruleName: string;
  action: RuleAction;
  matched: boolean;
  evaluatedAt: string;
}

/**
 * Evaluates a single rule against a context.
 * Uses simple expression evaluation (no eval for safety).
 */
function evaluateRule(
  rule: ReconciliationRule,
  ctx: RuleEvaluationContext
): RuleEvaluationResult {
  const result: RuleEvaluationResult = {
    ruleId: rule.id,
    ruleName: rule.name,
    action: rule.action,
    matched: false,
    evaluatedAt: new Date().toISOString(),
  };

  if (!rule.enabled) return result;

  try {
    result.matched = evaluateCondition(rule.condition, ctx);
  } catch (err) {
    log.warn("Rule condition evaluation failed", {
      ruleId: rule.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}

/**
 * Simple condition evaluator. Supports basic comparison operators
 * and property access on the context object.
 */
function evaluateCondition(condition: string, ctx: RuleEvaluationContext): boolean {
  // Normalize the condition
  const normalized = condition.trim();

  // Handle logical AND
  if (normalized.includes(" && ")) {
    const parts = normalized.split(" && ");
    return parts.every((part) => evaluateCondition(part, ctx));
  }

  // Handle logical OR
  if (normalized.includes(" || ")) {
    const parts = normalized.split(" || ");
    return parts.some((part) => evaluateCondition(part, ctx));
  }

  // Handle negation
  if (normalized.startsWith("!(") && normalized.endsWith(")")) {
    return !evaluateCondition(normalized.slice(2, -1), ctx);
  }

  // Handle equality
  if (normalized.includes(" === ")) {
    const [left, right] = normalized.split(" === ").map((s) => s.trim());
    const leftVal = resolveValue(left, ctx);
    const rightVal = resolveValue(right, ctx);
    return leftVal === rightVal;
  }

  if (normalized.includes(" !== ")) {
    const [left, right] = normalized.split(" !== ").map((s) => s.trim());
    const leftVal = resolveValue(left, ctx);
    const rightVal = resolveValue(right, ctx);
    return leftVal !== rightVal;
  }

  // Handle greater than or equal
  if (normalized.includes(" >= ")) {
    const [left, right] = normalized.split(" >= ").map((s) => s.trim());
    const leftVal = Number(resolveValue(left, ctx));
    const rightVal = Number(resolveValue(right, ctx));
    return leftVal >= rightVal;
  }

  // Handle less than
  if (normalized.includes(" < ")) {
    const [left, right] = normalized.split(" < ").map((s) => s.trim());
    const leftVal = Number(resolveValue(left, ctx));
    const rightVal = Number(resolveValue(right, ctx));
    return leftVal < rightVal;
  }

  // Handle method calls like .every()
  if (normalized.includes(".every(")) {
    const match = normalized.match(/^(\S+)\.every\((.+)\)$/);
    if (match) {
      const [, arrayExpr, predicate] = match;
      const arr = resolveValue(arrayExpr, ctx);
      if (Array.isArray(arr)) {
        return arr.every((item: unknown) => {
          const itemCtx = { ...ctx, match: { ...ctx.match, _item: item } };
          return evaluateCondition(predicate, itemCtx);
        });
      }
    }
  }

  // Handle .some()
  if (normalized.includes(".some(")) {
    const match = normalized.match(/^(\S+)\.some\((.+)\)$/);
    if (match) {
      const [, arrayExpr, predicate] = match;
      const arr = resolveValue(arrayExpr, ctx);
      if (Array.isArray(arr)) {
        return arr.some((item: unknown) => {
          const itemCtx = { ...ctx, match: { ...ctx.match, _item: item } };
          return evaluateCondition(predicate, itemCtx);
        });
      }
    }
  }

  // Handle parseFloat()
  if (normalized.startsWith("parseFloat(")) {
    const inner = normalized.slice("parseFloat(".length, -1);
    const val = resolveValue(inner, ctx);
    return parseFloat(String(val));
  }

  log.debug("Unparseable condition, defaulting to false", { condition: normalized });
  return false;
}

function resolveValue(expr: string, ctx: RuleEvaluationContext): unknown {
  const trimmed = expr.trim();

  // String literal
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  // Number literal
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  // Boolean
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // Property access: match.matchScore, internalRecord.amount, etc.
  const parts = trimmed.split(".");
  let current: unknown = ctx;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ─── Rule Engine Runner ───────────────────────────────────────────────────────

export interface RuleEngineResult {
  action: RuleAction;
  matchedRules: RuleEvaluationResult[];
  auditEntry: ReconciliationAuditEntry;
}

/**
 * Evaluates all rules against a match and returns the highest-priority action.
 */
export function evaluateRules(
  match: SettlementMatch,
  internalRecord: SettlementRecord,
  externalRecord: ExternalSettlementRecord,
  rules: ReconciliationRule[] = DEFAULT_RULES,
  historicalDiscrepancies = 0
): RuleEngineResult {
  const ctx: RuleEvaluationContext = {
    match,
    internalRecord,
    externalRecord,
    historicalDiscrepancies,
    timeSinceCreationMs: Date.now() - new Date(internalRecord.createdAt).getTime(),
  };

  // Sort rules by priority (lower number = higher priority)
  const sortedRules = [...rules].filter((r) => r.enabled).sort((a, b) => a.priority - b.priority);

  const matchedRules: RuleEvaluationResult[] = [];
  let finalAction: RuleAction = "flag_review"; // Default

  for (const rule of sortedRules) {
    const result = evaluateRule(rule, ctx);
    if (result.matched) {
      matchedRules.push(result);
      finalAction = rule.action;
      // First matched rule wins (highest priority)
      break;
    }
  }

  const auditEntry: ReconciliationAuditEntry = {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    discrepancyId: `${match.internalRecordId}-${match.externalRecordId}`,
    action: finalAction === "auto_match" || finalAction === "auto_resolve"
      ? "matched"
      : finalAction === "flag_review"
        ? "detected"
        : "escalated",
    performedBy: "system",
    details: {
      matchScore: match.matchScore,
      matchedRules: matchedRules.map((r) => r.ruleId),
      discrepancies: match.discrepancies,
    },
    timestamp: new Date().toISOString(),
  };

  log.info("Rule engine evaluation completed", {
    internalRecordId: match.internalRecordId,
    externalRecordId: match.externalRecordId,
    matchScore: match.matchScore,
    action: finalAction,
    matchedRules: matchedRules.map((r) => r.ruleId),
  });

  return {
    action: finalAction,
    matchedRules,
    auditEntry,
  };
}
