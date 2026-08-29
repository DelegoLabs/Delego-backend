/**
 * GraphQL query complexity analysis (Issue #100).
 *
 * Scoping note: this implements the complexity-scoring core needed to
 * reject expensive queries — depth checking and a per-field cost
 * estimator — as a provider-agnostic module operating on a minimal
 * abstract query-shape (`QueryNode`), not tied to a specific GraphQL
 * server. It does NOT stand up an actual GraphQL server/schema/resolvers,
 * DataLoader wiring, subscriptions, or persisted queries — choosing
 * Apollo vs Yoga vs Mercurius is a toolchain decision that shouldn't be
 * made unilaterally here. Whichever server is chosen, this module's
 * `computeQueryCost`/`checkQueryComplexity` can be wired into that
 * server's validation/plugin hooks with a small adapter that flattens its
 * AST into `QueryNode`s.
 */

/** A minimal, server-agnostic representation of one selected field in a
 * query, deep enough to compute depth and per-field cost. */
export interface QueryNode {
  fieldName: string;
  args: Record<string, unknown>;
  children: QueryNode[];
}

export type FieldCostEstimator = (args: Record<string, unknown>) => number;

export interface QueryComplexityConfig {
  maxDepth: number;
  maxComplexity: number;
  /** Per-field-name cost estimators. A field with no estimator here costs
   * `defaultFieldCost`. */
  estimators: Record<string, FieldCostEstimator>;
  /** Cost charged for a field with no specific estimator. */
  defaultFieldCost: number;
  /** Called with the computed cost after a successful check — for metrics,
   * not enforcement (enforcement is `checkQueryComplexity`'s return value). */
  onCost?: (cost: number) => void;
}

export const DEFAULT_FIELD_COST = 1;

/** Compute the maximum nesting depth of a query tree. A leaf field has
 * depth 1. */
export function computeQueryDepth(node: QueryNode): number {
  if (node.children.length === 0) return 1;
  return 1 + Math.max(...node.children.map(computeQueryDepth));
}

/**
 * Compute a query's total cost by summing each field's estimated cost
 * (recursively, including children). A field taking a `first`/`limit`
 * argument typically costs proportional to that limit — that's the
 * estimator's job, not this function's; this just sums whatever the
 * estimators (or the default) report.
 */
export function computeQueryCost(
  node: QueryNode,
  estimators: Record<string, FieldCostEstimator>,
  defaultFieldCost: number = DEFAULT_FIELD_COST,
): number {
  const ownCost = estimators[node.fieldName]?.(node.args) ?? defaultFieldCost;
  const childrenCost = node.children.reduce(
    (sum, child) => sum + computeQueryCost(child, estimators, defaultFieldCost),
    0,
  );
  return ownCost + childrenCost;
}

export interface QueryComplexityResult {
  allowed: boolean;
  depth: number;
  cost: number;
  reason?: "max_depth_exceeded" | "max_complexity_exceeded";
}

/**
 * Check a query against `config`'s depth and complexity limits. Depth is
 * checked before cost, since a too-deep query is rejected outright
 * regardless of what its cost would compute to (an unbounded-depth query
 * can also produce a misleadingly small cost sum if leaf fields are cheap).
 */
export function checkQueryComplexity(
  node: QueryNode,
  config: QueryComplexityConfig,
): QueryComplexityResult {
  const depth = computeQueryDepth(node);
  if (depth > config.maxDepth) {
    return { allowed: false, depth, cost: 0, reason: "max_depth_exceeded" };
  }

  const cost = computeQueryCost(node, config.estimators, config.defaultFieldCost);
  config.onCost?.(cost);

  if (cost > config.maxComplexity) {
    return { allowed: false, depth, cost, reason: "max_complexity_exceeded" };
  }

  return { allowed: true, depth, cost };
}

/**
 * A cost estimator for a paginated field — cost scales with the requested
 * page size (`first`/`limit` argument), floored at 1 so an unpaginated or
 * zero-limit call still costs something.
 */
export function paginatedFieldCost(argName: "first" | "limit" = "first", perItemCost = 1): FieldCostEstimator {
  return (args: Record<string, unknown>) => {
    const requested = args[argName];
    const count = typeof requested === "number" && requested > 0 ? requested : 1;
    return count * perItemCost;
  };
}
