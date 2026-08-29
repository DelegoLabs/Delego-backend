import { FraudCheckResult } from "../models/FraudCheckResult.js";
import { FraudCase } from "../models/FraudCase.js";
import { FraudEventLog } from "../models/FraudEventLog.js";
import { AnalyticsMetrics } from "../schemas.js";
import { Op } from "sequelize";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("fraud-detection:analytics", process.env.LOG_LEVEL ?? "info");

/**
 * Fraud Analytics Service
 */
export class FraudAnalyticsService {
  /**
   * Get fraud rate metrics
   */
  async getFraudRateMetrics(periodDays: number = 30): Promise<{
    totalTransactions: number;
    flaggedTransactions: number;
    fraudConfirmed: number;
    fraudRate: number;
    averageScore: number;
    byTimePeriod: Array<{ period: string; total: number; flagged: number; fraud: number }>;
    byChannel: Array<{ channel: string; total: number; flagged: number; fraud: number }>;
  }> {
    const periodStart = new Date();
    periodStart.setDate(periodStart.getDate() - periodDays);

    // Total transactions
    const total = await FraudCheckResult.count({
      where: {
        scored_at: {
          [Op.gte]: periodStart,
        },
      },
    });

    // Flagged transactions (review or decline)
    const flagged = await FraudCheckResult.count({
      where: {
        scored_at: {
          [Op.gte]: periodStart,
        },
        recommendation: { [Op.in]: ["review", "decline"] },
      },
    });

    // Confirmed fraud cases
    const fraudConfirmed = await FraudCase.count({
      where: {
        status: "confirmed_fraud",
        created_at: {
          [Op.gte]: periodStart,
        },
      },
    });

    // Average score
    const scoreResult = await FraudCheckResult.findOne({
      attributes: [[FraudCheckResult.sequelize!.fn("AVG", FraudCheckResult.sequelize!.col("score")), "average"]],
      where: {
        scored_at: {
          [Op.gte]: periodStart,
        },
      },
      raw: true,
    });

    const averageScore = scoreResult?.average ? parseFloat(scoreResult.average as string) : 0;

    // By time period (weekly)
    const byTimePeriod = await this.getFraudByTimePeriod(periodDays);

    // By channel (will need channel data in fraud_check_results)
    const byChannel: Array<{ channel: string; total: number; flagged: number; fraud: number }> = [];

    return {
      totalTransactions: total,
      flaggedTransactions: flagged,
      fraudConfirmed,
      fraudRate: total > 0 ? flagged / total : 0,
      averageScore,
      byTimePeriod,
      byChannel,
    };
  }

  /**
   * Get analytics metrics
   */
  async getAnalyticsMetrics(): Promise<AnalyticsMetrics> {
    const metrics = await this.getFraudRateMetrics(30);

    return {
      totalTransactions: metrics.totalTransactions,
      flaggedTransactions: metrics.flaggedTransactions,
      fraudConfirmed: metrics.fraudConfirmed,
      fraudRate: metrics.fraudRate,
      averageScore: metrics.averageScore,
      byTimePeriod: metrics.byTimePeriod,
      byChannel: metrics.byChannel,
    };
  }

  /**
   * Get fraud trends
   */
  async getFraudTrends(periodDays: number = 90): Promise<Array<{ date: string; total: number; flagged: number; fraud: number }>> {
    const periodStart = new Date();
    periodStart.setDate(periodStart.getDate() - periodDays);

    const results = await FraudCheckResult.findAll({
      attributes: [
        [FraudCheckResult.sequelize!.fn("DATE", FraudCheckResult.sequelize!.col("scored_at")), "date"],
        [FraudCheckResult.sequelize!.fn("COUNT", FraudCheckResult.sequelize!.col("id")), "total"],
        [FraudCheckResult.sequelize!.fn("SUM", FraudCheckResult.sequelize!.case([
          { when: FraudCheckResult.sequelize!.col("recommendation").in(["review", "decline"]), then: 1 }],
          0)), "flagged"],
      ],
      where: {
        scored_at: {
          [Op.gte]: periodStart,
        },
      },
      group: [FraudCheckResult.sequelize!.fn("DATE", FraudCheckResult.sequelize!.col("scored_at"))],
      order: [["date", "ASC"]],
      raw: true,
    });

    return results.map((r) => ({
      date: r.date as string,
      total: parseInt(r.total as string, 10),
      flagged: parseInt(r.flagged as string, 10),
      fraud: 0, // Will need fraud cases join for accurate count
    }));
  }

  /**
   * Get top fraud-triggering rules
   */
  async getTopFraudRules(limit: number = 10): Promise<Array<{ ruleName: string; triggerCount: number; avgScoreImpact: number }>> {
    // Get rules from database
    const rules = await FraudCheckResult.findAll({
      attributes: ["rules_triggered"],
      limit: 1000,
      where: {
        recommendation: { [Op.in]: ["review", "decline"] },
      },
    });

    const ruleCounts: Record<string, number> = {};
    const ruleScores: Record<string, number[]> = {};

    for (const result of rules) {
      const rulesTriggered = result.rules_triggered as string[];
      const score = result.score as number;

      for (const rule of rulesTriggered) {
        ruleCounts[rule] = (ruleCounts[rule] || 0) + 1;
        if (!ruleScores[rule]) ruleScores[rule] = [];
        ruleScores[rule].push(score);
      }
    }

    const topRules = Object.entries(ruleCounts)
      .map(([name, count]) => ({
        ruleName: name,
        triggerCount: count,
        avgScoreImpact: ruleScores[name] ? Math.round(ruleScores[name].reduce((a, b) => a + b, 0) / ruleScores[name].length) : 0,
      }))
      .sort((a, b) => b.triggerCount - a.triggerCount)
      .slice(0, limit);

    return topRules;
  }

  /**
   * Get fraud by time period
   */
  private async getFraudByTimePeriod(days: number): Promise<Array<{ period: string; total: number; flagged: number; fraud: number }>> {
    const periodStart = new Date();
    periodStart.setDate(periodStart.getDate() - days);

    const results = await FraudCheckResult.findAll({
      attributes: [
        [FraudCheckResult.sequelize!.fn("DATE_TRUNC", "week", FraudCheckResult.sequelize!.col("scored_at")), "week"],
        [FraudCheckResult.sequelize!.fn("COUNT", FraudCheckResult.sequelize!.col("id")), "total"],
        [FraudCheckResult.sequelize!.fn("SUM", FraudCheckResult.sequelize!.case([
          { when: FraudCheckResult.sequelize!.col("recommendation").in(["review", "decline"]), then: 1 }],
          0)), "flagged"],
      ],
      where: {
        scored_at: {
          [Op.gte]: periodStart,
        },
      },
      group: [FraudCheckResult.sequelize!.fn("DATE_TRUNC", "week", FraudCheckResult.sequelize!.col("scored_at"))],
      order: [["week", "DESC"]],
      raw: true,
    });

    return results.map((r) => ({
      period: r.week as string,
      total: parseInt(r.total as string, 10),
      flagged: parseInt(r.flagged as string, 10),
      fraud: 0, // Would need fraud cases for accurate count
    }));
  }

  /**
   * Get fraud by channel
   */
  private async getFraudByChannel(): Promise<Array<{ channel: string; total: number; flagged: number; fraud: number }>> {
    // This would require channel field in fraud_check_results
    return [];
  }

  /**
   * Get false positive rate
   */
  async getFalsePositiveRate(): Promise<number> {
    // Get confirmed fraud cases
    const confirmedFraud = await FraudCase.count({
      where: { status: "confirmed_fraud" },
    });

    // Get cases marked as false positive
    const falsePositive = await FraudCase.count({
      where: { status: "false_positive" },
    });

    // Get all resolved cases
    const resolved = await FraudCase.count({
      where: {
        status: { [Op.in]: ["confirmed_fraud", "false_positive", "closed"] },
      },
    });

    return resolved > 0 ? falsePositive / resolved : 0;
  }

  /**
   * Get model performance metrics
   */
  async getModelPerformance(): Promise<{
    precision: number;
    recall: number;
    f1Score: number;
    accuracy: number;
    falsePositiveRate: number;
  }> {
    // In production, this would calculate actual metrics from model predictions vs ground truth
    // For now, return mock values that would be updated during retraining

    return {
      precision: 0.92,
      recall: 0.88,
      f1Score: 0.90,
      accuracy: 0.95,
      falsePositiveRate: 0.018,
    };
  }
}

export const fraudAnalyticsService = new FraudAnalyticsService();
