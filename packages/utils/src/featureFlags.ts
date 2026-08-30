/**
 * Feature flag evaluation engine (Issue #94).
 *
 * Scoping note: this implements the evaluation core — targeting rules,
 * deterministic percentage rollout, multivariate values, and an audit
 * trail — as an in-process, synchronous evaluator with no external
 * dependency. It does NOT integrate a hosted flag service (LaunchDarkly,
 * Unleash), a management UI/API, or a CSI-style live-update mechanism —
 * choosing a flag backend is a product/infra decision that shouldn't be
 * made unilaterally here. `FeatureFlagStore` is a minimal in-memory
 * implementation; a real deployment would swap it for a store backed by
 * whichever service is chosen, without changing `evaluateFlag`.
 */

import { createHash } from "node:crypto";

export type FlagValueType = "boolean" | "string" | "number" | "json";
export type TargetingOperator = "in" | "not_in" | "contains" | "matches" | "gt" | "lt";
export type EvaluationReason = "default" | "target_match" | "rollout" | "disabled";

export interface TargetingRule {
  id: string;
  attribute: string;
  operator: TargetingOperator;
  values: unknown[];
  /** Percentage (0-100) of matching users who receive the rule's value.
   * Bucketing is deterministic per (flagKey, userId) so a user's outcome
   * doesn't flap between evaluations. */
  rollout: number;
  /** Value served when this rule matches (and the user lands in the
   * rollout bucket). Falls back to the flag's defaultValue otherwise. */
  value?: unknown;
}

export interface FeatureFlag {
  key: string;
  name: string;
  description: string;
  type: FlagValueType;
  enabled: boolean;
  defaultValue: unknown;
  targetingRules: TargetingRule[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface FlagEvaluation {
  flagKey: string;
  userId: string;
  context: Record<string, unknown>;
  value: unknown;
  reason: EvaluationReason;
  matchedRuleId?: string;
}

export interface FlagAuditEntry {
  flagKey: string;
  action: "created" | "updated" | "enabled" | "disabled";
  actor: string;
  timestamp: string;
  previousValue?: unknown;
  newValue?: unknown;
}

/**
 * Hash (flagKey, userId) into a stable [0, 100) bucket. Using a hash
 * (rather than random) keeps a given user's rollout outcome stable across
 * evaluations and process restarts, without persisting per-user state.
 */
export function bucketFor(flagKey: string, userId: string): number {
  const hash = createHash("sha256").update(`${flagKey}:${userId}`).digest();
  // First 4 bytes as an unsigned int, mod 100 — uniform enough for rollout
  // percentages, and avoids pulling in a dedicated hashing library.
  const value = hash.readUInt32BE(0);
  return value % 100;
}

function matchesRule(rule: TargetingRule, context: Record<string, unknown>): boolean {
  const actual = context[rule.attribute];
  switch (rule.operator) {
    case "in":
      return rule.values.includes(actual);
    case "not_in":
      return !rule.values.includes(actual);
    case "contains":
      return typeof actual === "string" && rule.values.some((v) => typeof v === "string" && actual.includes(v));
    case "matches":
      return rule.values.some((v) => typeof v === "string" && typeof actual === "string" && new RegExp(v).test(actual));
    case "gt":
      return typeof actual === "number" && rule.values.some((v) => typeof v === "number" && actual > v);
    case "lt":
      return typeof actual === "number" && rule.values.some((v) => typeof v === "number" && actual < v);
    default:
      return false;
  }
}

/**
 * Evaluate `flag` for `userId` given `context`. Pure and synchronous —
 * no I/O, so this is the part of the system that can genuinely hit the
 * issue's "< 1ms" evaluation target regardless of which backend eventually
 * stores the flag definitions.
 */
export function evaluateFlag(
  flag: FeatureFlag,
  userId: string,
  context: Record<string, unknown> = {},
): FlagEvaluation {
  const base = { flagKey: flag.key, userId, context };

  if (!flag.enabled) {
    return { ...base, value: flag.defaultValue, reason: "disabled" };
  }

  for (const rule of flag.targetingRules) {
    if (!matchesRule(rule, context)) continue;

    const bucket = bucketFor(flag.key, userId);
    if (bucket >= rule.rollout) continue;

    return {
      ...base,
      value: rule.value ?? flag.defaultValue,
      reason: rule.rollout < 100 ? "rollout" : "target_match",
      matchedRuleId: rule.id,
    };
  }

  return { ...base, value: flag.defaultValue, reason: "default" };
}

/**
 * Minimal in-memory flag store with an append-only audit log. Intended as
 * a reference implementation to swap out once a real flag backend is
 * chosen — `evaluateFlag` above doesn't depend on this class at all.
 */
export class FeatureFlagStore {
  private flags: Map<string, FeatureFlag> = new Map();
  private audit: FlagAuditEntry[] = [];

  create(flag: FeatureFlag, actor: string): void {
    if (this.flags.has(flag.key)) {
      throw new Error(`Feature flag already exists: ${flag.key}`);
    }
    this.flags.set(flag.key, flag);
    this.audit.push({
      flagKey: flag.key,
      action: "created",
      actor,
      timestamp: new Date().toISOString(),
      newValue: flag.defaultValue,
    });
  }

  get(key: string): FeatureFlag | undefined {
    return this.flags.get(key);
  }

  setEnabled(key: string, enabled: boolean, actor: string): FeatureFlag {
    const flag = this.mustGet(key);
    const previousValue = flag.enabled;
    flag.enabled = enabled;
    flag.updatedAt = new Date().toISOString();
    this.audit.push({
      flagKey: key,
      action: enabled ? "enabled" : "disabled",
      actor,
      timestamp: flag.updatedAt,
      previousValue,
      newValue: enabled,
    });
    return flag;
  }

  updateTargetingRules(key: string, rules: TargetingRule[], actor: string): FeatureFlag {
    const flag = this.mustGet(key);
    const previousValue = flag.targetingRules;
    flag.targetingRules = rules;
    flag.updatedAt = new Date().toISOString();
    this.audit.push({
      flagKey: key,
      action: "updated",
      actor,
      timestamp: flag.updatedAt,
      previousValue,
      newValue: rules,
    });
    return flag;
  }

  evaluate(key: string, userId: string, context: Record<string, unknown> = {}): FlagEvaluation {
    return evaluateFlag(this.mustGet(key), userId, context);
  }

  getAuditLog(key?: string): FlagAuditEntry[] {
    return key ? this.audit.filter((entry) => entry.flagKey === key) : [...this.audit];
  }

  private mustGet(key: string): FeatureFlag {
    const flag = this.flags.get(key);
    if (!flag) throw new Error(`Feature flag not found: ${key}`);
    return flag;
  }
}
