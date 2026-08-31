/**
 * Burn Rate Calculator for SLO Alerting
 *
 * Calculates burn rates for different time windows and determines
 * alert severity based on thresholds.
 */

import { createLogger } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BurnRateResult {
  window: string;
  rate: number;
  severity: BurnRateSeverity;
}

export type BurnRateSeverity = "none" | "warning" | "critical";

export interface BurnRateWindow {
  window: string;
  seconds: number;
  multiplier: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Burn Rate Calculator
// ─────────────────────────────────────────────────────────────────────────────

export class BurnRateCalculator {
  private burnRates = new Map<string, Map<string, number>>();

  // Standard burn rate windows
  private windows: BurnRateWindow[] = [
    { window: "1h", seconds: 3600, multiplier: 1 },
    { window: "6h", seconds: 21600, multiplier: 6 },
    { window: "24h", seconds: 86400, multiplier: 24 },
    { window: "48h", seconds: 172800, multiplier: 48 },
  ];

  // Calculate burn rate for a given SLO
  calculateBurnRate(
    sloId: string,
    target: number,
    actualAvailability: number,
    now: Date = new Date()
  ): { [key: string]: number } {
    const errorRate = 1 - actualAvailability;
    const targetErrorRate = 1 - target;
    
    // Burn rate = actual error rate / target error rate
    // If actual = target, burn rate = 1 (on budget)
    // If actual < target, burn rate < 1 (under budget)
    // If actual > target, burn rate > 1 (burning budget faster)
    
    const burnRate = errorRate / targetErrorRate;
    
    // Calculate smoothed burn rates for different windows
    const rates: { [key: string]: number } = {};
    
    this.windows.forEach((window) => {
      // For longer windows, we smooth the burn rate
      const smoothedRate = this.smoothBurnRate(burnRate, window.multiplier);
      rates[window.window] = smoothedRate;
      
      this.storeBurnRate(sloId, window.window, smoothedRate, now);
    });

    return rates;
  }

  // Calculate burn rate with threshold-based severity
  calculateWithThresholds(
    sloId: string,
    target: number,
    actualAvailability: number,
    thresholds: { warning: number; critical: number },
    now: Date = new Date()
  ): { [key: string]: BurnRateResult } {
    const rates = this.calculateBurnRate(sloId, target, actualAvailability, now);
    const results: { [key: string]: BurnRateResult } = {};

    Object.entries(rates).forEach(([window, rate]) => {
      const severity = this.determineSeverity(rate, thresholds);
      results[window] = { window, rate, severity };
    });

    return results;
  }

  // Get burn rate severity for a specific window
  getSeverity(rate: number, thresholds: { warning: number; critical: number }): BurnRateSeverity {
    if (rate >= thresholds.critical) {
      return "critical";
    }
    if (rate >= thresholds.warning) {
      return "warning";
    }
    return "none";
  }

  // Determine severity based on rate and thresholds
  private determineSeverity(
    rate: number,
    thresholds: { warning: number; critical: number }
  ): BurnRateSeverity {
    if (rate >= thresholds.critical) {
      return "critical";
    }
    if (rate >= thresholds.warning) {
      return "warning";
    }
    return "none";
  }

  // Smooth burn rate for longer windows
  private smoothBurnRate(burnRate: number, windowMultiplier: number): number {
    // Exponential smoothing factor based on window size
    // Smaller windows = less smoothing, larger windows = more smoothing
    const smoothingFactor = 0.3 / Math.sqrt(windowMultiplier);
    return burnRate * smoothingFactor + 1 * (1 - smoothingFactor);
  }

  // Store burn rate for history
  private storeBurnRate(
    sloId: string,
    window: string,
    rate: number,
    now: Date
  ): void {
    let windowRates = this.burnRates.get(sloId);
    if (!windowRates) {
      windowRates = new Map<string, number>();
      this.burnRates.set(sloId, windowRates);
    }
    windowRates.set(window, rate);
  }

  // Get historical burn rate
  getHistoricalBurnRate(sloId: string, window: string): number | undefined {
    return this.burnRates.get(sloId)?.get(window);
  }

  // Check if any burn rate is above threshold
  checkThresholds(
    sloId: string,
    target: number,
    actualAvailability: number,
    thresholds: { warning: number; critical: number }
  ): BurnRateResult[] {
    const results = this.calculateWithThresholds(sloId, target, actualAvailability, thresholds);
    
    return Object.values(results).filter(
      (r) => r.severity !== "none"
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fast Burn Detector
// ─────────────────────────────────────────────────────────────────────────────

export class FastBurnDetector {
  private fastBurnWindowSeconds = 600; // 10 minutes

  // Detect if error budget is burning fast
  detectFastBurn(
    sloId: string,
    target: number,
    actualAvailability: number,
    errorBudget: number,
    now: Date = new Date()
  ): boolean {
    // Fast burn = consuming more than 20% of error budget in 10 minutes
    const fastBurnThreshold = errorBudget * 0.2;
    
    // Calculate expected error budget consumption for 10 minutes
    const errorRate = 1 - actualAvailability;
    const targetErrorRate = 1 - target;
    const burnRate = errorRate / targetErrorRate;
    
    // Expected consumption in 10 minutes (as fraction of total budget)
    const consumption10m = (burnRate * (this.fastBurnWindowSeconds / 3600)) / 24;
    
    return consumption10m > 0.2;
  }

  // Get fast burn alert
  getFastBurnAlert(
    sloId: string,
    service: string,
    target: number,
    actualAvailability: number,
    errorBudget: number,
    burnRate: number
  ): {
    alertType: "fast_burn_warning" | "fast_burn_critical";
    message: string;
    severity: "warning" | "critical";
    metadata: Record<string, unknown>;
  } | null {
    if (burnRate < 2) return null;

    const isCritical = burnRate >= 6;
    const alertType = isCritical ? "fast_burn_critical" : "fast_burn_warning";
    const severity = isCritical ? "critical" : "warning";

    return {
      alertType,
      message: `Error budget burning ${burnRate.toFixed(1)}x faster than allowed`,
      severity,
      metadata: {
        sloId,
        service,
        burnRate,
        target,
        actualAvailability,
        errorBudget,
        window: "10m",
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Slow Burn Detector
// ─────────────────────────────────────────────────────────────────────────────

export class SlowBurnDetector {
  // Detect if error budget is burning slow but consistently
  detectSlowBurn(
    sloId: string,
    target: number,
    actualAvailability: number,
    errorBudget: number,
    window: string,
    now: Date = new Date()
  ): boolean {
    // Slow burn = consistent error budget consumption over longer period
    const consumptionRate = this.estimateConsumptionRate(
      actualAvailability,
      target,
      window
    );
    
    // If we're consuming more than 5% of budget per day consistently
    return consumptionRate > 0.05;
  }

  // Estimate daily consumption rate
  private estimateConsumptionRate(
    actualAvailability: number,
    target: number,
    window: string
  ): number {
    const errorRate = 1 - actualAvailability;
    const targetErrorRate = 1 - target;
    const burnRate = errorRate / targetErrorRate;
    
    // For 24h window, assume linear extrapolation
    if (window === "rolling_24h") {
      return burnRate * 0.1; // 10% of budget per day
    }
    
    // For shorter windows, extrapolate to 24h
    const windowHours = this.getWindowHours(window);
    return (burnRate * 24) / windowHours;
  }

  private getWindowHours(window: string): number {
    switch (window) {
      case "rolling_1h":
        return 1;
      case "rolling_24h":
        return 24;
      case "rolling_7d":
        return 168;
      case "rolling_30d":
        return 720;
      default:
        return 1;
    }
  }

  // Get slow burn alert
  getSlowBurnAlert(
    sloId: string,
    service: string,
    target: number,
    actualAvailability: number,
    errorBudget: number,
    window: string,
    dailyConsumption: number
  ): {
    alertType: "slow_burn_warning" | "slow_burn_critical";
    message: string;
    severity: "warning" | "critical";
    metadata: Record<string, unknown>;
  } | null {
    if (dailyConsumption <= 0.05) return null;

    const isCritical = dailyConsumption >= 0.2;
    const alertType = isCritical ? "slow_burn_critical" : "slow_burn_warning";
    const severity = isCritical ? "critical" : "warning";

    // Calculate time to exhaustion
    const daysToExhaustion = errorBudget / (errorBudget * dailyConsumption);

    return {
      alertType,
      message: `Error budget will be exhausted in ${daysToExhaustion.toFixed(1)} days at current rate`,
      severity,
      metadata: {
        sloId,
        service,
        dailyConsumption,
        daysToExhaustion,
        window,
        target,
        actualAvailability,
        errorBudget,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

const log = createLogger("utils:slo-burnrate", process.env.LOG_LEVEL ?? "info");