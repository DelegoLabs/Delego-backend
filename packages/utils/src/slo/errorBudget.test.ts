/**
 * Tests for Error Budget Tracker
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ErrorBudgetTracker } from "./errorBudget.js";

describe("ErrorBudgetTracker", () => {
  let tracker: ErrorBudgetTracker;

  beforeEach(() => {
    tracker = new ErrorBudgetTracker();
  });

  describe("Calculate Error Budget", () => {
    it("should calculate error budget for 1h window", () => {
      const budget = tracker.calculateErrorBudget(0.999, "rolling_1h");
      
      // (1 - 0.999) * 3600 seconds = 3.6 seconds
      expect(budget).toBeCloseTo(3.6);
    });

    it("should calculate error budget for 24h window", () => {
      const budget = tracker.calculateErrorBudget(0.999, "rolling_24h");
      
      // (1 - 0.999) * 86400 seconds = 86.4 seconds
      expect(budget).toBeCloseTo(86.4);
    });

    it("should calculate error budget for 7d window", () => {
      const budget = tracker.calculateErrorBudget(0.999, "rolling_7d");
      
      // (1 - 0.999) * 604800 seconds = 604.8 seconds
      expect(budget).toBeCloseTo(604.8);
    });
  });

  describe("Track Consumption", () => {
    it("should track budget when availability meets target", () => {
      const state = tracker.trackConsumption(
        "slo_1",
        "gateway",
        0.999,
        "rolling_24h",
        0.9995
      );

      expect(state.sloId).toBe("slo_1");
      expect(state.actual).toBe(0.9995);
      expect(state.consumed).toBeCloseTo(0);
      expect(state.remaining).toBeCloseTo(state.budget);
      expect(state.status.current).toBe("healthy");
    });

    it("should track budget when availability is below target", () => {
      const state = tracker.trackConsumption(
        "slo_1",
        "gateway",
        0.999,
        "rolling_24h",
        0.995
      );

      expect(state.sloId).toBe("slo_1");
      expect(state.actual).toBe(0.995);
      expect(state.consumed).toBeGreaterThan(0);
      expect(state.remaining).toBeLessThan(state.budget);
      expect(state.status.current).toBe("critical");
    });

    it("should mark budget as exhausted when consumption is high", () => {
      const state = tracker.trackConsumption(
        "slo_1",
        "gateway",
        0.999,
        "rolling_24h",
        0.95
      );

      expect(state.status.current).toBe("exhausted");
    });
  });

  describe("Get Budget State", () => {
    it("should return budget state for SLO", () => {
      tracker.trackConsumption("slo_1", "gateway", 0.999, "rolling_24h", 0.9995);
      
      const state = tracker.getBudgetState("slo_1");
      expect(state).toBeDefined();
      expect(state?.sloId).toBe("slo_1");
    });

    it("should return undefined for non-existent SLO", () => {
      const state = tracker.getBudgetState("nonexistent");
      expect(state).toBeUndefined();
    });
  });

  describe("Update Burn Rate", () => {
    it("should update burn rate", () => {
      const rate = tracker.updateBurnRate("slo_1", 0.999, 0.9995, "rolling_24h");
      expect(rate).toBeGreaterThan(0);
    });
  });

  describe("All Budget States", () => {
    it("should return all budget states", () => {
      tracker.trackConsumption("slo_1", "gateway", 0.999, "rolling_24h", 0.9995);
      tracker.trackConsumption("slo_2", "payments", 0.999, "rolling_24h", 0.999);
      
      const states = tracker.getAllBudgetStates();
      expect(states.length).toBeGreaterThanOrEqual(2);
    });
  });
});