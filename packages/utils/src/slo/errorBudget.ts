/**
 * Error Budget Tracker
 *
 * Calculates and tracks error budget consumption based on SLO targets.
 */

import { createLogger } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ErrorBudgetState {
  sloId: string;
  period: ErrorBudgetPeriod;
  target: number;
  actual: number;
  budget: number;
  consumed: number;
  remaining: number;
  burnRate: {
    "1h": number;
    "6h": number;
    "24h": number;
  };
  status: ErrorBudgetStatus;
}

export interface ErrorBudgetPeriod {
  start: string;
  end: string;
  window: string;
}

export interface ErrorBudgetStatus {
  current: "healthy" | "warning" | "critical" | "exhausted";
  warningThreshold: number;
  criticalThreshold: number;
  exhaustedAt?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Budget Tracker
// ─────────────────────────────────────────────────────────────────────────────

export class ErrorBudgetTracker {
  private budgets = new Map<string, ErrorBudgetState>();
  private burnRateCalculator: BurnRateCalculator;

  constructor() {
    this.burnRateCalculator = new BurnRateCalculator();
  }

  // ─── Calculate Error Budget ────────────────────────────────────────────

  calculateErrorBudget(sloTarget: number, window: string): number {
    // Error budget = (1 - target) * total time in window
    // For example: 0.1% SLO = 0.001 budget
    // Rolling 1h = 3600 seconds * 0.001 = 3.6 seconds of errors allowed
    
    const windowSeconds = this.getWindowSeconds(window);
    const budget = (1 - sloTarget) * windowSeconds;
    
    return budget;
  }

  // ─── Track Error Budget Consumption ───────────────────────────────────

  trackConsumption(
    sloId: string,
    service: string,
    target: number,
    window: string,
    actualAvailability: number,
    now: Date = new Date()
  ): ErrorBudgetState {
    const period = this.getPeriod(window, now);
    const budget = this.calculateErrorBudget(target, window);
    
    // Calculate consumed budget based on actual availability
    // If actual is below target, we've consumed more budget
    const availabilityRatio = actualAvailability / target;
    const consumed = budget * (1 - availabilityRatio);
    
    // Ensure consumed is not negative
    const safeConsumed = Math.max(0, consumed);
    
    // Calculate remaining budget
    const remaining = Math.max(0, budget - safeConsumed);
    
    // Determine status based on consumption percentage
    const consumptionPercentage = (safeConsumed / budget) * 100;
    const status = this.determineStatus(consumptionPercentage, budget);

    // Calculate burn rate
    const burnRate = this.burnRateCalculator.calculateBurnRate(
      sloId,
      target,
      actualAvailability,
      window,
      now
    );

    const state: ErrorBudgetState = {
      sloId,
      period,
      target,
      actual: actualAvailability,
      budget,
      consumed: safeConsumed,
      remaining,
      burnRate,
      status,
    };

    this.budgets.set(sloId, state);
    
    return state;
  }

  // ─── Get Error Budget State ───────────────────────────────────────────

  getBudgetState(sloId: string): ErrorBudgetState | undefined {
    return this.budgets.get(sloId);
  }

  // ─── Get All Budget States ────────────────────────────────────────────

  getAllBudgetStates(): ErrorBudgetState[] {
    return Array.from(this.budgets.values());
  }

  // ─── Update Burn Rate ─────────────────────────────────────────────────

  updateBurnRate(
    sloId: string,
    target: number,
    actualAvailability: number,
    window: string,
    now: Date = new Date()
  ): number {
    return this.burnRateCalculator.calculateBurnRate(
      sloId,
      target,
      actualAvailability,
      window,
      now
    )["1h"];
  }

  // ─── Determine Status ─────────────────────────────────────────────────

  private determineStatus(consumptionPercentage: number, budget: number): ErrorBudgetStatus {
    // Calculate thresholds based on remaining budget
    const remainingPercentage = (budget - (budget * consumptionPercentage / 100)) / budget * 100;
    
    // Status thresholds
    const warningThreshold = 50;  // Warning when 50% of budget consumed
    const criticalThreshold = 80; // Critical when 80% of budget consumed

    if (consumptionPercentage >= criticalThreshold) {
      return {
        current: "exhausted",
        warningThreshold,
        criticalThreshold,
        exhaustedAt: new Date().toISOString(),
      };
    }
    
    if (consumptionPercentage >= warningThreshold) {
      return {
        current: "critical",
        warningThreshold,
        criticalThreshold,
      };
    }

    if (consumptionPercentage >= warningThreshold * 0.5) {
      return {
        current: "warning",
        warningThreshold,
        criticalThreshold,
      };
    }

    return {
      current: "healthy",
      warningThreshold,
      criticalThreshold,
    };
  }

  // ─── Helper Methods ───────────────────────────────────────────────────

  private getPeriod(window: string, now: Date): { start: string; end: string } {
    const end = now.toISOString();
    let start: Date;

    switch (window) {
      case "rolling_1h":
        start = new Date(now.getTime() - 3600000); // 1 hour
        break;
      case "rolling_24h":
        start = new Date(now.getTime() - 86400000); // 24 hours
        break;
      case "rolling_7d":
        start = new Date(now.getTime() - 604800000); // 7 days
        break;
      case "rolling_30d":
        start = new Date(now.getTime() - 2592000000); // 30 days
        break;
      default:
        start = new Date(now.getTime() - 3600000); // Default to 1h
    }

    return {
      start: start.toISOString(),
      end,
      window,
    };
  }

  private getWindowSeconds(window: string): number {
    switch (window) {
      case "rolling_1h":
        return 3600;
      case "rolling_24h":
        return 86400;
      case "rolling_7d":
        return 604800;
      case "rolling_30d":
        return 2592000;
      default:
        return 3600;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Burn Rate Calculator
// ─────────────────────────────────────────────────────────────────────────────

export class BurnRateCalculator {
  private burnRates = new Map<string, Map<string, number>>();

  calculateBurnRate(
    sloId: string,
    target: number,
    actualAvailability: number,
    window: string,
    now: Date = new Date()
  ): { [key: string]: number } {
    // Burn rate = (1 - actual) / (1 - target)
    // If actual = target, burn rate = 1 (on budget)
    // If actual < target, burn rate > 1 (burning budget faster)
    
    const errorBudgetRatio = (1 - actualAvailability) / (1 - target);
    const burnRate1h = errorBudgetRatio;
    
    // For longer windows, we smooth the burn rate
    const burnRate6h = this.smoothBurnRate(burnRate1h, 6);
    const burnRate24h = this.smoothBurnRate(burnRate1h, 24);

    const rates: { [key: string]: number } = {
      "1h": burnRate1h,
      "6h": burnRate6h,
      "24h": burnRate24h,
    };

    // Store for history
    this.storeBurnRate(sloId, window, rates["1h"], now);

    return rates;
  }

  private smoothBurnRate(burnRate: number, windowHours: number): number {
    // Simple smoothing: average with previous readings
    // In production, this would use historical data
    const smoothingFactor = 0.3;
    return burnRate * smoothingFactor + 1 * (1 - smoothingFactor);
  }

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

  getHistoricalBurnRate(sloId: string, window: string): number | undefined {
    return this.burnRates.get(sloId)?.get(window);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

const log = createLogger("utils:slo-budget", process.env.LOG_LEVEL ?? "info");