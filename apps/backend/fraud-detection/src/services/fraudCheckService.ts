import { FraudCheckResult } from "../models/FraudCheckResult.js";
import { FraudCase } from "../models/FraudCase.js";
import { DeviceFingerprint } from "../models/DeviceFingerprint.js";
import { FraudEventLog } from "../models/FraudEventLog.js";
import { mlScorer } from "../mlScorer.js";
import { ruleEngine } from "../ruleEngine.js";
import { FeatureStore } from "../featureStore.js";
import { FraudCheckRequest, FraudCheckResponse } from "../schemas.js";
import { randomUUID } from "crypto";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("fraud-detection:check", process.env.LOG_LEVEL ?? "info");

/**
 * Fraud Check Service - Main service for transaction fraud detection
 */
export class FraudCheckService {
  private featureStore: FeatureStore;

  constructor() {
    this.featureStore = new FeatureStore(process.env.REDIS_URL ?? "redis://localhost:6379");
  }

  /**
   * Check a transaction for fraud
   */
  async checkTransaction(request: FraudCheckRequest): Promise<FraudCheckResponse> {
    const startTime = performance.now();

    // Get velocity features
    const customerVelocity = await this.featureStore.getCustomerVelocity(request.customerId);
    const ipVelocity = await this.featureStore.getIPVelocity(request.ipAddress);
    const emailVelocity = await this.featureStore.getEmailVelocity(request.email);

    // Get device history
    const deviceHistory = await this.featureStore.getDeviceHistory(request.deviceFingerprint);

    // Calculate region fraud rate
    const regionFraudRate = await this.featureStore.getRegionFraudRate(request.billingAddress.country);

    // Prepare ML features
    const mlFeatures = {
      amount: parseFloat(request.amount),
      velocity_count: customerVelocity.transactionCount,
      velocity_amount: customerVelocity.totalAmount,
      ip_distinct_customers: ipVelocity.distinctCustomers,
      email_distinct_accounts: emailVelocity.distinctAccounts,
      device_flagged: deviceHistory.isFlagged ? 1 : 0,
      region_fraud_rate: regionFraudRate,
      is_new_customer: customerVelocity.transactionCount === 0 ? 1 : 0,
      is_new_device: deviceHistory.totalTransactions === 0 ? 1 : 0,
      amount_to_avg_ratio: customerVelocity.transactionCount > 0 ? parseFloat(request.amount) / (customerVelocity.totalAmount / customerVelocity.transactionCount) : 1,
    };

    // Get rules
    await ruleEngine.loadRules();

    // Evaluate rules
    const ruleResults = await ruleEngine.evaluateRules(request, mlFeatures);

    // Calculate ML score
    const mlScoreResult = await mlScorer.calculateScore(mlFeatures);

    // Combine scores
    const combinedScore = Math.min(Math.max(mlScoreResult.score + ruleResults.scoreImpact, 0), 100);

    // Get risk level and recommendation
    const riskLevel = mlScorer.getRiskLevel(combinedScore);
    const recommendation = mlScorer.getRecommendation(combinedScore);

    // Create factors array
    const factors = [...mlScoreResult.factors, ...ruleResults.rulesTriggered.map((name) => ({
      name: `rule_${name}`,
      value: true,
      weight: 0.1,
      contribution: 5,
    }))];

    const response: FraudCheckResponse = {
      transactionId: request.transactionId,
      score: combinedScore,
      riskLevel,
      factors,
      rulesTriggered: ruleResults.rulesTriggered,
      recommendation,
      modelVersion: mlScorer.getVersion(),
      scoredAt: new Date().toISOString(),
      reviewRequired: recommendation === "review" || recommendation === "decline",
    };

    // Save check result
    await this.saveCheckResult(request, response);

    // Store features for velocity tracking
    await this.featureStore.storeTransactionFeature(
      request.customerId,
      request.ipAddress,
      request.email,
      request.metadata.merchantId || "unknown",
      request.metadata.cardLast4 || "0000",
      parseFloat(request.amount),
      recommendation !== "approve",
    );

    // Store device fingerprint
    await this.featureStore.storeDeviceFingerprint(
      request.deviceFingerprint,
      request.customerId,
      request.metadata.deviceType || "unknown",
      request.metadata.browser || "unknown",
      request.metadata.os || "unknown",
    );

    // Store region fraud data
    await this.featureStore.storeRegionFraudData(request.billingAddress.country, recommendation !== "approve");

    // Log fraud event
    if (recommendation !== "approve") {
      await this.logFraudEvent("transaction_flagged", request, {
        score: combinedScore,
        riskLevel,
        recommendation,
        rulesTriggered: ruleResults.rulesTriggered,
      });
    }

    const elapsed = performance.now() - startTime;
    log.info("Transaction fraud check completed", {
      transactionId: request.transactionId,
      score: combinedScore,
      riskLevel,
      recommendation,
      durationMs: Math.round(elapsed),
    });

    return response;
  }

  /**
   * Save fraud check result to database
   */
  private async saveCheckResult(request: FraudCheckRequest, result: FraudCheckResponse): Promise<void> {
    try {
      await FraudCheckResult.create({
        transactionId: request.transactionId,
        score: result.score,
        riskLevel: result.riskLevel,
        factors: result.factors,
        rulesTriggered: result.rulesTriggered,
        recommendation: result.recommendation,
        modelVersion: result.modelVersion,
        scoredAt: new Date(),
      });

      // Create fraud case if needed
      if (result.recommendation !== "approve") {
        await FraudCase.create({
          transactionId: request.transactionId,
          status: "open",
          priority: result.riskLevel === "critical" ? "urgent" : result.riskLevel === "high" ? "high" : result.riskLevel === "medium" ? "medium" : "low",
        });
      }
    } catch (err) {
      log.error("Failed to save fraud check result", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Log fraud event
   */
  private async logFraudEvent(eventType: string, request: FraudCheckRequest, details: Record<string, unknown>): Promise<void> {
    try {
      await FraudEventLog.create({
        eventId: randomUUID(),
        eventType,
        transactionId: request.transactionId,
        customerId: request.customerId,
        details,
        severity: this.getEventSeverity(eventType, details),
      });
    } catch (err) {
      log.warn("Failed to log fraud event", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Get event severity
   */
  private getEventSeverity(eventType: string, details: Record<string, unknown>): "info" | "warning" | "error" | "critical" {
    const score = details.score as number;
    if (score >= 90) return "critical";
    if (score >= 70) return "error";
    if (score >= 50) return "warning";
    return "info";
  }

  /**
   * Get check results by transaction ID
   */
  async getCheckResult(transactionId: string): Promise<FraudCheckResult | null> {
    return FraudCheckResult.findOne({ where: { transaction_id: transactionId } });
  }

  /**
   * Close feature store
   */
  async close(): Promise<void> {
    await this.featureStore.close();
  }
}

export const fraudCheckService = new FraudCheckService();
