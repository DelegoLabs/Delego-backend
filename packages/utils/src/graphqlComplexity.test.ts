import { describe, it, expect, vi } from "vitest";
import {
  computeQueryDepth,
  computeQueryCost,
  checkQueryComplexity,
  paginatedFieldCost,
  DEFAULT_FIELD_COST,
  type QueryNode,
} from "./graphqlComplexity.js";

function leaf(fieldName: string, args: Record<string, unknown> = {}): QueryNode {
  return { fieldName, args, children: [] };
}

function node(fieldName: string, children: QueryNode[], args: Record<string, unknown> = {}): QueryNode {
  return { fieldName, args, children };
}

describe("computeQueryDepth", () => {
  it("returns 1 for a single leaf field", () => {
    expect(computeQueryDepth(leaf("user"))).toBe(1);
  });

  it("returns the depth of the deepest branch", () => {
    const query = node("user", [node("orders", [leaf("items")])]);
    expect(computeQueryDepth(query)).toBe(3);
  });

  it("takes the max across multiple sibling branches", () => {
    const query = node("user", [leaf("name"), node("orders", [leaf("id")])]);
    expect(computeQueryDepth(query)).toBe(3);
  });
});

describe("computeQueryCost", () => {
  it("charges the default cost for a leaf field with no estimator", () => {
    expect(computeQueryCost(leaf("name"), {})).toBe(DEFAULT_FIELD_COST);
  });

  it("sums costs across children", () => {
    const query = node("user", [leaf("name"), leaf("email")]);
    expect(computeQueryCost(query, {})).toBe(3); // user + name + email
  });

  it("uses a field-specific estimator when provided", () => {
    const estimators = { orders: () => 10 };
    const query = node("user", [node("orders", [], {})], {});
    expect(computeQueryCost(query, estimators)).toBe(1 + 10);
  });

  it("respects a custom defaultFieldCost", () => {
    expect(computeQueryCost(leaf("name"), {}, 5)).toBe(5);
  });
});

describe("checkQueryComplexity", () => {
  it("allows a query within depth and complexity limits", () => {
    const query = node("user", [leaf("name")]);
    const result = checkQueryComplexity(query, {
      maxDepth: 5,
      maxComplexity: 100,
      estimators: {},
      defaultFieldCost: 1,
    });
    expect(result.allowed).toBe(true);
    expect(result.depth).toBe(2);
    expect(result.cost).toBe(2);
  });

  it("rejects a query exceeding maxDepth", () => {
    const query = node("a", [node("b", [node("c", [leaf("d")])])]);
    const result = checkQueryComplexity(query, {
      maxDepth: 2,
      maxComplexity: 1000,
      estimators: {},
      defaultFieldCost: 1,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("max_depth_exceeded");
  });

  it("rejects a query exceeding maxComplexity even within depth limits", () => {
    const query = node("user", [leaf("orders", { first: 500 })]);
    const result = checkQueryComplexity(query, {
      maxDepth: 5,
      maxComplexity: 50,
      estimators: { orders: paginatedFieldCost("first") },
      defaultFieldCost: 1,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("max_complexity_exceeded");
  });

  it("checks depth before cost — a too-deep query is rejected regardless of cost", () => {
    const query = node("a", [node("b", [node("c", [leaf("d")])])]);
    const result = checkQueryComplexity(query, {
      maxDepth: 1,
      maxComplexity: 1, // would also fail cost, but depth should be reported
      estimators: {},
      defaultFieldCost: 1,
    });
    expect(result.reason).toBe("max_depth_exceeded");
  });

  it("calls onCost with the computed cost when the query is allowed", () => {
    const onCost = vi.fn();
    const query = leaf("name");
    checkQueryComplexity(query, { maxDepth: 5, maxComplexity: 100, estimators: {}, defaultFieldCost: 1, onCost });
    expect(onCost).toHaveBeenCalledWith(1);
  });

  it("does not call onCost when the query is rejected for depth", () => {
    const onCost = vi.fn();
    const query = node("a", [leaf("b")]);
    checkQueryComplexity(query, { maxDepth: 1, maxComplexity: 100, estimators: {}, defaultFieldCost: 1, onCost });
    expect(onCost).not.toHaveBeenCalled();
  });
});

describe("paginatedFieldCost", () => {
  it("scales cost with the requested page size", () => {
    const estimator = paginatedFieldCost("first", 2);
    expect(estimator({ first: 10 })).toBe(20);
  });

  it("floors at 1 item when no limit argument is given", () => {
    const estimator = paginatedFieldCost("first");
    expect(estimator({})).toBe(1);
  });

  it("floors at 1 item for a zero or negative limit", () => {
    const estimator = paginatedFieldCost("limit");
    expect(estimator({ limit: 0 })).toBe(1);
    expect(estimator({ limit: -5 })).toBe(1);
  });

  it("supports a custom argument name", () => {
    const estimator = paginatedFieldCost("limit", 3);
    expect(estimator({ limit: 5 })).toBe(15);
  });
});
