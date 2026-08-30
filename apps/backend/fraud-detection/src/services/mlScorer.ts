import { createLogger } from "@delegolabs/utils";
import * as fs from "fs";
import * as path from "path";
import { URL } from "url";

const log = createLogger("fraud-detection:ml", process.env.LOG_LEVEL ?? "info");

/**
 * ML Scorer - XGBoost-based fraud prediction
 */
export class MLScorer {
  private modelPath: string;
  private modelVersion: string;
  private model: any | null = null;

  constructor(modelPath: string = process.env.MODEL_PATH ?? path.join("models", "fraud_xgboost.json")) {
    this.modelPath = modelPath;
    this.modelVersion = process.env.MODEL_VERSION ?? "v1.0.0";
  }

  /**
   * Load the XGBoost model
   */
  async loadModel(): Promise<void> {
    try {
      const modelData = await fs.promises.readFile(this.modelPath, "utf-8");
      this.model = JSON.parse(modelData);
      log.info("ML model loaded successfully", { modelVersion: this.modelVersion, modelPath: this.modelPath });
    } catch (err) {
      log.error("Failed to load ML model", { error: err instanceof Error ? err.message : String(err) });
      // Initialize with default model if file doesn't exist
      this.model = this.createDefaultModel();
    }
  }

  /**
   * Create a default model (fallback)
   */
  private createDefaultModel(): any {
    return {
      version: this.modelVersion,
      features: [
        "amount",
        "velocity_count",
        "velocity_amount",
        "ip_distinct_customers",
        "email_distinct_accounts",
        "device_flagged",
        "region_fraud_rate",
        "is_new_customer",
        "is_new_device",
        "amount_to_avg_ratio",
      ],
      thresholds: {
        low: 30,
        medium: 50,
        high: 70,
        critical: 90,
      },
      weights: {
        amount: 0.15,
        velocity_count: 0.2,
        velocity_amount: 0.15,
        ip_distinct_customers: 0.1,
        email_distinct_accounts: 0.1,
        device_flagged: 0.1,
        region_fraud_rate: 0.05,
        is_new_customer: 0.05,
        is_new_device: 0.05,
        amount_to_avg_ratio: 0.05,
      },
    };
  }

  /**
   * Calculate fraud score
   */
  async calculateScore(features: Record<string, unknown>): Promise<{ score: number; factors: Array<{ name: string; value: unknown; weight: number; contribution: number }> }> {
    if (!this.model) {
      await this.loadModel();
    }

    const defaultFeatures = this.getDefaultFeatures();
    const combinedFeatures = { ...defaultFeatures, ...features };

    const factors: Array<{ name: string; value: unknown; weight: number; contribution: number }> = [];
    let totalContribution = 0;

    // Calculate score based on features
    for (const [featureName, value] of Object.entries(combinedFeatures)) {
      const weight = this.model.weights?.[featureName] ?? 0;
      const contribution = this.calculateFeatureContribution(featureName, value, weight);
      totalContribution += contribution;
      factors.push({
        name: featureName,
        value,
        weight,
        contribution,
      });
    }

    // Scale score to 0-100
    const rawScore = Math.min(Math.max(totalContribution * 10, 0), 100);
    const score = Math.round(rawScore);

    return {
      score,
      factors,
    };
  }

  /**
   * Calculate contribution for a feature
   */
  private calculateFeatureContribution(name: string, value: unknown, weight: number): number {
    if (typeof value !== "number") return 0;

    // Normalize different feature types to 0-1 range
    let normalized = 0;

    switch (name) {
      case "amount":
        // Higher amounts are more suspicious (normalize to $1000)
        normalized = Math.min(value / 1000, 1);
        break;
      case "velocity_count":
        // Higher frequency is more suspicious
        normalized = Math.min(value / 50, 1);
        break;
      case "velocity_amount":
        // Higher total velocity is more suspicious
        normalized = Math.min(value / 10000, 1);
        break;
      case "ip_distinct_customers":
        // Many customers from same IP is suspicious
        normalized = Math.min(value / 10, 1);
        break;
      case "email_distinct_accounts":
        // Many accounts from same email is suspicious
        normalized = Math.min(value / 5, 1);
        break;
      case "device_flagged":
        // Previously flagged device
        normalized = value > 0 ? 1 : 0;
        break;
      case "region_fraud_rate":
        normalized = value;
        break;
      case "is_new_customer":
        normalized = value > 0 ? 1 : 0;
        break;
      case "is_new_device":
        normalized = value > 0 ? 1 : 0;
        break;
      case "amount_to_avg_ratio":
        // Much higher than average is suspicious
        normalized = Math.min(value, 5) / 5;
        break;
      default:
        normalized = Math.min(Math.abs(value), 1) / 1;
    }

    return normalized * weight;
  }

  /**
   * Get risk level from score
   */
  getRiskLevel(score: number): "low" | "medium" | "high" | "critical" {
    if (!this.model) {
      return score < 30 ? "low" : score < 50 ? "medium" : score < 70 ? "high" : "critical";
    }

    const thresholds = this.model.thresholds || { low: 30, medium: 50, high: 70, critical: 90 };

    if (score >= thresholds.critical) return "critical";
    if (score >= thresholds.high) return "high";
    if (score >= thresholds.medium) return "medium";
    return "low";
  }

  /**
   * Get recommendation based on score
   */
  getRecommendation(score: number): "approve" | "review" | "decline" {
    if (score < 30) return "approve";
    if (score < 70) return "review";
    return "decline";
  }

  /**
   * Get all features
   */
  getFeatures(): string[] {
    return this.model?.features || [];
  }

  /**
   * Get model version
   */
  getVersion(): string {
    return this.modelVersion;
  }

  /**
   * Get model thresholds
   */
  getThresholds(): { low: number; medium: number; high: number; critical: number } {
    return this.model?.thresholds || { low: 30, medium: 50, high: 70, critical: 90 };
  }

  /**
   * Get model weights
   */
  getWeights(): Record<string, number> {
    return this.model?.weights || {};
  }

  /**
   * Get model details
   */
  getModelInfo(): {
    version: string;
    features: string[];
    thresholds: Record<string, number>;
    weights: Record<string, number>;
  } {
    return {
      version: this.modelVersion,
      features: this.getFeatures(),
      thresholds: this.getThresholds(),
      weights: this.getWeights(),
    };
  }
}

export const mlScorer = new MLScorer();
