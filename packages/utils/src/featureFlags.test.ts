import { describe, it, expect, beforeEach } from "vitest";
import {
  bucketFor,
  evaluateFlag,
  FeatureFlagStore,
  type FeatureFlag,
  type TargetingRule,
} from "./featureFlags.js";

function buildFlag(overrides: Partial<FeatureFlag> = {}): FeatureFlag {
  return {
    key: "new-checkout-flow",
    name: "New Checkout Flow",
    description: "test flag",
    type: "boolean",
    enabled: true,
    defaultValue: false,
    targetingRules: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdBy: "admin",
    ...overrides,
  };
}

describe("bucketFor", () => {
  it("is deterministic for the same flag key and user id", () => {
    expect(bucketFor("flag-a", "user-1")).toBe(bucketFor("flag-a", "user-1"));
  });

  it("returns a value in [0, 100)", () => {
    for (const userId of ["u1", "u2", "u3", "u4", "u5"]) {
      const bucket = bucketFor("flag-a", userId);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
  });

  it("distributes different users across different buckets (not all identical)", () => {
    const buckets = new Set(
      Array.from({ length: 50 }, (_, i) => bucketFor("flag-a", `user-${i}`)),
    );
    expect(buckets.size).toBeGreaterThan(1);
  });
});

describe("evaluateFlag — disabled flag", () => {
  it("returns the default value with reason 'disabled', ignoring targeting rules", () => {
    const flag = buildFlag({
      enabled: false,
      defaultValue: false,
      targetingRules: [{ id: "r1", attribute: "plan", operator: "in", values: ["pro"], rollout: 100, value: true }],
    });
    const result = evaluateFlag(flag, "user-1", { plan: "pro" });
    expect(result.value).toBe(false);
    expect(result.reason).toBe("disabled");
  });
});

describe("evaluateFlag — no matching rules", () => {
  it("returns the default value with reason 'default'", () => {
    const flag = buildFlag({ targetingRules: [] });
    const result = evaluateFlag(flag, "user-1", {});
    expect(result.value).toBe(false);
    expect(result.reason).toBe("default");
  });
});

describe("evaluateFlag — targeting rules", () => {
  it("returns the rule's value when the rule matches and rollout is 100%", () => {
    const rule: TargetingRule = { id: "r1", attribute: "plan", operator: "in", values: ["pro"], rollout: 100, value: true };
    const flag = buildFlag({ targetingRules: [rule] });
    const result = evaluateFlag(flag, "user-1", { plan: "pro" });
    expect(result.value).toBe(true);
    expect(result.reason).toBe("target_match");
    expect(result.matchedRuleId).toBe("r1");
  });

  it("falls through to default when the rule's attribute does not match", () => {
    const rule: TargetingRule = { id: "r1", attribute: "plan", operator: "in", values: ["pro"], rollout: 100, value: true };
    const flag = buildFlag({ targetingRules: [rule] });
    const result = evaluateFlag(flag, "user-1", { plan: "free" });
    expect(result.value).toBe(false);
    expect(result.reason).toBe("default");
  });

  it("evaluates rules in order and stops at the first match", () => {
    const rules: TargetingRule[] = [
      { id: "r1", attribute: "plan", operator: "in", values: ["pro"], rollout: 100, value: "first" },
      { id: "r2", attribute: "plan", operator: "in", values: ["pro"], rollout: 100, value: "second" },
    ];
    const flag = buildFlag({ targetingRules: rules, defaultValue: "default" });
    const result = evaluateFlag(flag, "user-1", { plan: "pro" });
    expect(result.value).toBe("first");
    expect(result.matchedRuleId).toBe("r1");
  });

  it("supports the not_in operator", () => {
    const rule: TargetingRule = { id: "r1", attribute: "plan", operator: "not_in", values: ["free"], rollout: 100, value: true };
    const flag = buildFlag({ targetingRules: [rule] });
    expect(evaluateFlag(flag, "u1", { plan: "pro" }).value).toBe(true);
    expect(evaluateFlag(flag, "u1", { plan: "free" }).value).toBe(false);
  });

  it("supports the gt and lt operators", () => {
    const gtRule: TargetingRule = { id: "r1", attribute: "age", operator: "gt", values: [18], rollout: 100, value: true };
    const flag = buildFlag({ targetingRules: [gtRule] });
    expect(evaluateFlag(flag, "u1", { age: 25 }).value).toBe(true);
    expect(evaluateFlag(flag, "u1", { age: 10 }).value).toBe(false);
  });

  it("supports the contains operator for substring matching", () => {
    const rule: TargetingRule = { id: "r1", attribute: "email", operator: "contains", values: ["@delegolabs.com"], rollout: 100, value: true };
    const flag = buildFlag({ targetingRules: [rule] });
    expect(evaluateFlag(flag, "u1", { email: "dev@delegolabs.com" }).value).toBe(true);
    expect(evaluateFlag(flag, "u1", { email: "dev@example.com" }).value).toBe(false);
  });
});

describe("evaluateFlag — percentage rollout", () => {
  it("is deterministic: the same user always gets the same rollout outcome", () => {
    const rule: TargetingRule = { id: "r1", attribute: "plan", operator: "in", values: ["pro"], rollout: 50, value: true };
    const flag = buildFlag({ targetingRules: [rule] });
    const first = evaluateFlag(flag, "user-42", { plan: "pro" });
    const second = evaluateFlag(flag, "user-42", { plan: "pro" });
    expect(first.value).toBe(second.value);
    expect(first.reason).toBe(second.reason);
  });

  it("reports reason 'rollout' (not 'target_match') for a partial rollout", () => {
    // Find a user who lands within a 100% "matches" test to isolate reason vs rollout%.
    const rule: TargetingRule = { id: "r1", attribute: "plan", operator: "in", values: ["pro"], rollout: 50, value: true };
    const flag = buildFlag({ targetingRules: [rule] });
    // Search for a userId whose bucket falls under 50 so the rule actually applies.
    let matched: string | undefined;
    for (let i = 0; i < 200; i++) {
      const uid = `search-${i}`;
      if (evaluateFlag(flag, uid, { plan: "pro" }).reason === "rollout") {
        matched = uid;
        break;
      }
    }
    expect(matched).toBeDefined();
  });

  it("excludes users outside the rollout percentage from the rule's value", () => {
    const rule: TargetingRule = { id: "r1", attribute: "plan", operator: "in", values: ["pro"], rollout: 0, value: true };
    const flag = buildFlag({ targetingRules: [rule], defaultValue: false });
    const result = evaluateFlag(flag, "user-1", { plan: "pro" });
    expect(result.value).toBe(false);
    expect(result.reason).toBe("default");
  });
});

describe("FeatureFlagStore", () => {
  let store: FeatureFlagStore;

  beforeEach(() => {
    store = new FeatureFlagStore();
  });

  it("creates and retrieves a flag", () => {
    const flag = buildFlag();
    store.create(flag, "admin");
    expect(store.get(flag.key)).toEqual(flag);
  });

  it("rejects creating a flag with a duplicate key", () => {
    store.create(buildFlag(), "admin");
    expect(() => store.create(buildFlag(), "admin")).toThrow(/already exists/);
  });

  it("evaluates a stored flag directly by key", () => {
    store.create(buildFlag({ enabled: true, defaultValue: "on" }), "admin");
    expect(store.evaluate("new-checkout-flow", "user-1").value).toBe("on");
  });

  it("throws when evaluating an unknown flag key", () => {
    expect(() => store.evaluate("does-not-exist", "user-1")).toThrow(/not found/);
  });

  it("records an audit entry when a flag is created", () => {
    store.create(buildFlag(), "admin-1");
    const log = store.getAuditLog("new-checkout-flow");
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe("created");
    expect(log[0].actor).toBe("admin-1");
  });

  it("records an audit entry when a flag is toggled (kill switch)", () => {
    store.create(buildFlag({ enabled: true }), "admin-1");
    store.setEnabled("new-checkout-flow", false, "oncall-engineer");

    const log = store.getAuditLog("new-checkout-flow");
    expect(log).toHaveLength(2);
    expect(log[1].action).toBe("disabled");
    expect(log[1].actor).toBe("oncall-engineer");
    expect(store.get("new-checkout-flow")?.enabled).toBe(false);
  });

  it("records an audit entry when targeting rules are updated", () => {
    store.create(buildFlag(), "admin-1");
    const newRules: TargetingRule[] = [{ id: "r1", attribute: "plan", operator: "in", values: ["pro"], rollout: 100 }];
    store.updateTargetingRules("new-checkout-flow", newRules, "admin-2");

    const log = store.getAuditLog("new-checkout-flow");
    expect(log[log.length - 1].action).toBe("updated");
    expect(store.get("new-checkout-flow")?.targetingRules).toEqual(newRules);
  });

  it("getAuditLog with no key returns entries across all flags", () => {
    store.create(buildFlag({ key: "flag-a" }), "admin");
    store.create(buildFlag({ key: "flag-b" }), "admin");
    expect(store.getAuditLog()).toHaveLength(2);
  });
});
