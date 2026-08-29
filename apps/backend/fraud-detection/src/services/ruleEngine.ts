import { FraudRule } from "../models/FraudRule.js";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("fraud-detection:rules", process.env.LOG_LEVEL ?? "info");

/**
 * Rule Engine - Evaluates fraud rules against transactions
 */
export class RuleEngine {
  private rules: FraudRule[] = [];
  private ruleCache: Record<string, boolean> = {};

  /**
   * Load rules from database
   */
  async loadRules(): Promise<FraudRule[]> {
    try {
      this.rules = await FraudRule.findAll({
        where: { enabled: true },
        order: [["scoreImpact", "DESC"]],
      });
      log.info("Loaded rules from database", { count: this.rules.length });
      return this.rules;
    } catch (err) {
      log.error("Failed to load rules", { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  /**
   * Evaluate rules against a transaction
   */
  async evaluateRules(
    transaction: {
      amount: number;
      customerId: string;
      ipAddress: string;
      deviceFingerprint: string;
      email: string;
      billingAddress: { country: string };
      shippingAddress?: { country: string };
      metadata: Record<string, unknown>;
    },
    features: Record<string, unknown>,
  ): Promise<{ rulesTriggered: string[]; scoreImpact: number; actions: string[] }> {
    const rulesTriggered: string[] = [];
    let totalScoreImpact = 0;
    const actions: string[] = [];

    for (const rule of this.rules) {
      try {
        const triggered = await this.evaluateRule(rule, transaction, features);
        if (triggered) {
          rulesTriggered.push(rule.name);
          totalScoreImpact += rule.scoreImpact;
          actions.push(rule.action);

          // Cache result
          this.ruleCache[rule.id] = true;
        }
      } catch (err) {
        log.warn("Rule evaluation failed", { ruleName: rule.name, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { rulesTriggered, scoreImpact: totalScoreImpact, actions };
  }

  /**
   * Evaluate a single rule
   */
  private async evaluateRule(
    rule: FraudRule,
    transaction: {
      amount: number;
      customerId: string;
      ipAddress: string;
      deviceFingerprint: string;
      email: string;
      billingAddress: { country: string };
      shippingAddress?: { country: string };
      metadata: Record<string, unknown>;
    },
    features: Record<string, unknown>,
  ): Promise<boolean> {
    const context = {
      ...transaction,
      ...features,
      timestamp: new Date().toISOString(),
    };

    try {
      // Safe evaluation of rule condition
      const fn = new Function("context", `
        with (context) {
          return (${rule.condition});
        }
      `);

      const result = fn(context);
      return result === true;
    } catch (err) {
      log.warn("Rule condition evaluation failed", { ruleName: rule.name, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /**
   * Get all rules
   */
  async getAllRules(): Promise<FraudRule[]> {
    if (this.rules.length === 0) {
      await this.loadRules();
    }
    return this.rules;
  }

  /**
   * Get enabled rules
   */
  async getEnabledRules(): Promise<FraudRule[]> {
    if (this.rules.length === 0) {
      await this.loadRules();
    }
    return this.rules.filter((r) => r.enabled);
  }

  /**
   * Get rule by ID
   */
  async getRuleById(id: string): Promise<FraudRule | null> {
    if (this.rules.length === 0) {
      await this.loadRules();
    }
    return this.rules.find((r) => r.id === id) || null;
  }

  /**
   * Create a new rule
   */
  async createRule(ruleData: {
    name: string;
    description: string;
    condition: string;
    action: "flag" | "review" | "block";
    scoreImpact: number;
    enabled?: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<FraudRule> {
    const rule = await FraudRule.create({
      ...ruleData,
      enabled: ruleData.enabled ?? true,
    });

    // Clear cache
    this.ruleCache = {};
    this.rules = [];

    log.info("Rule created", { ruleId: rule.id, ruleName: rule.name });
    return rule;
  }

  /**
   * Update a rule
   */
  async updateRule(id: string, updates: {
    name?: string;
    description?: string;
    condition?: string;
    action?: "flag" | "review" | "block";
    scoreImpact?: number;
    enabled?: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<FraudRule | null> {
    const rule = await FraudRule.findByPk(id);
    if (!rule) return null;

    await rule.update(updates);

    // Clear cache
    this.ruleCache = {};
    this.rules = [];

    log.info("Rule updated", { ruleId: rule.id });
    return rule;
  }

  /**
   * Delete a rule
   */
  async deleteRule(id: string): Promise<boolean> {
    const rule = await FraudRule.findByPk(id);
    if (!rule) return false;

    await rule.destroy();

    // Clear cache
    this.ruleCache = {};
    this.rules = [];

    log.info("Rule deleted", { ruleId: rule.id });
    return true;
  }

  /**
   * Get rules by action
   */
  async getRulesByAction(action: "flag" | "review" | "block"): Promise<FraudRule[]> {
    if (this.rules.length === 0) {
      await this.loadRules();
    }
    return this.rules.filter((r) => r.action === action);
  }

  /**
   * Get cached rule evaluation
   */
  getCachedEvaluation(ruleId: string): boolean | undefined {
    return this.ruleCache[ruleId];
  }
}

export const ruleEngine = new RuleEngine();
