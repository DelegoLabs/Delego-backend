import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../models/FraudRule.js", () => ({
  FraudRule: {
    findAll: vi.fn(),
    findByPk: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock("@delegolabs/utils", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { RuleEngine } from "./ruleEngine.js";
import { FraudRule } from "../models/FraudRule.js";

const baseTransaction = {
  amount: 100,
  customerId: "cust-1",
  ipAddress: "1.2.3.4",
  deviceFingerprint: "fp-1",
  email: "user@example.com",
  billingAddress: { country: "US" },
  shippingAddress: { country: "US" },
  metadata: {},
};

function makeRule(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "rule-1",
    name: "high_amount",
    condition: "amount > 500",
    action: "review",
    scoreImpact: 20,
    enabled: true,
    ...overrides,
  } as any;
}

describe("RuleEngine", () => {
  let engine: RuleEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new RuleEngine();
  });

  describe("loadRules", () => {
    it("loads enabled rules ordered by scoreImpact", async () => {
      const rules = [makeRule()];
      (FraudRule.findAll as any).mockResolvedValue(rules);

      const result = await engine.loadRules();

      expect(FraudRule.findAll).toHaveBeenCalledWith({
        where: { enabled: true },
        order: [["scoreImpact", "DESC"]],
      });
      expect(result).toEqual(rules);
    });

    it("returns an empty array when the database fails", async () => {
      (FraudRule.findAll as any).mockRejectedValue(new Error("db down"));

      const result = await engine.loadRules();

      expect(result).toEqual([]);
    });
  });

  describe("evaluateRules", () => {
    it("returns no triggers when there are no rules", async () => {
      const result = await engine.evaluateRules(baseTransaction, {});

      expect(result).toEqual({ rulesTriggered: [], scoreImpact: 0, actions: [] });
    });

    it("accumulates score and actions for triggered rules", async () => {
      (FraudRule.findAll as any).mockResolvedValue([
        makeRule({ id: "r1", name: "big", condition: "amount > 50", scoreImpact: 30, action: "block" }),
        makeRule({ id: "r2", name: "us", condition: "billingAddress.country === 'US'", scoreImpact: 10, action: "flag" }),
        makeRule({ id: "r3", name: "never", condition: "amount > 1000", scoreImpact: 99, action: "block" }),
      ]);
      await engine.loadRules();

      const result = await engine.evaluateRules(baseTransaction, {});

      expect(result.rulesTriggered).toEqual(["big", "us"]);
      expect(result.scoreImpact).toBe(40);
      expect(result.actions).toEqual(["block", "flag"]);
    });

    it("caches triggered rule ids", async () => {
      (FraudRule.findAll as any).mockResolvedValue([makeRule({ id: "r1", condition: "amount > 50" })]);
      await engine.loadRules();

      await engine.evaluateRules(baseTransaction, {});

      expect(engine.getCachedEvaluation("r1")).toBe(true);
      expect(engine.getCachedEvaluation("unknown")).toBeUndefined();
    });

    it("exposes features to rule conditions", async () => {
      (FraudRule.findAll as any).mockResolvedValue([
        makeRule({ id: "r1", condition: "velocity_count >= 3", scoreImpact: 15 }),
      ]);
      await engine.loadRules();

      const hit = await engine.evaluateRules(baseTransaction, { velocity_count: 5 });
      expect(hit.rulesTriggered).toEqual(["high_amount"]);

      const miss = await engine.evaluateRules(baseTransaction, { velocity_count: 1 });
      expect(miss.rulesTriggered).toEqual([]);
    });

    it("treats non-boolean-true results as not triggered", async () => {
      (FraudRule.findAll as any).mockResolvedValue([
        makeRule({ id: "r1", condition: "amount", scoreImpact: 10 }),
      ]);
      await engine.loadRules();

      const result = await engine.evaluateRules(baseTransaction, {});

      expect(result.rulesTriggered).toEqual([]);
      expect(result.scoreImpact).toBe(0);
    });

    it("treats syntactically invalid conditions as not triggered", async () => {
      (FraudRule.findAll as any).mockResolvedValue([
        makeRule({ id: "r1", condition: "amount >>> (", scoreImpact: 10 }),
      ]);
      await engine.loadRules();

      const result = await engine.evaluateRules(baseTransaction, {});

      expect(result.rulesTriggered).toEqual([]);
    });
  });

  describe("getAllRules / getEnabledRules / getRuleById / getRulesByAction", () => {
    it("loads rules lazily when cache is empty", async () => {
      (FraudRule.findAll as any).mockResolvedValue([
        makeRule({ id: "a", action: "block" }),
        makeRule({ id: "b", action: "review", enabled: false }),
      ]);

      const all = await engine.getAllRules();
      expect(all).toHaveLength(2);
      expect(FraudRule.findAll).toHaveBeenCalledTimes(1);

      // cached now, no second query
      await engine.getAllRules();
      expect(FraudRule.findAll).toHaveBeenCalledTimes(1);
    });

    it("getEnabledRules filters out disabled rules", async () => {
      (FraudRule.findAll as any).mockResolvedValue([
        makeRule({ id: "a", enabled: true }),
        makeRule({ id: "b", enabled: false }),
      ]);

      const enabled = await engine.getEnabledRules();
      expect(enabled.map((r: any) => r.id)).toEqual(["a"]);
    });

    it("getRuleById returns the match or null", async () => {
      (FraudRule.findAll as any).mockResolvedValue([makeRule({ id: "a" })]);

      expect((await engine.getRuleById("a"))?.id).toBe("a");
      expect(await engine.getRuleById("missing")).toBeNull();
    });

    it("getRulesByAction filters by action", async () => {
      (FraudRule.findAll as any).mockResolvedValue([
        makeRule({ id: "a", action: "block" }),
        makeRule({ id: "b", action: "review" }),
        makeRule({ id: "c", action: "block" }),
      ]);

      const blocks = await engine.getRulesByAction("block");
      expect(blocks.map((r: any) => r.id)).toEqual(["a", "c"]);
    });
  });

  describe("createRule", () => {
    it("creates an enabled rule by default and clears cache", async () => {
      (FraudRule.findAll as any).mockResolvedValue([makeRule({ id: "r1", condition: "amount > 50" })]);
      await engine.loadRules();
      await engine.evaluateRules(baseTransaction, {});
      expect(engine.getCachedEvaluation("r1")).toBe(true);

      const created = { id: "new", name: "n" };
      (FraudRule.create as any).mockResolvedValue(created);

      const result = await engine.createRule({
        name: "n",
        description: "d",
        condition: "amount > 1",
        action: "flag",
        scoreImpact: 5,
      });

      expect(FraudRule.create).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
      expect(result).toBe(created);
      expect(engine.getCachedEvaluation("r1")).toBeUndefined();
    });
  });

  describe("updateRule", () => {
    it("returns null when the rule does not exist", async () => {
      (FraudRule.findByPk as any).mockResolvedValue(null);

      expect(await engine.updateRule("x", { enabled: false })).toBeNull();
    });

    it("applies updates and clears cache when rule exists", async () => {
      const update = vi.fn();
      (FraudRule.findByPk as any).mockResolvedValue({ id: "r1", update });

      const result = await engine.updateRule("r1", { scoreImpact: 50 });

      expect(update).toHaveBeenCalledWith({ scoreImpact: 50 });
      expect(result).toEqual({ id: "r1", update });
    });
  });

  describe("deleteRule", () => {
    it("returns false when the rule does not exist", async () => {
      (FraudRule.findByPk as any).mockResolvedValue(null);

      expect(await engine.deleteRule("x")).toBe(false);
    });

    it("destroys the rule and returns true when it exists", async () => {
      const destroy = vi.fn();
      (FraudRule.findByPk as any).mockResolvedValue({ id: "r1", destroy });

      expect(await engine.deleteRule("r1")).toBe(true);
      expect(destroy).toHaveBeenCalledTimes(1);
    });
  });
});
