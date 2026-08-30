/**
 * Tests for Burn Rate Calculator
 */

import { describe, it, expect, beforeEach } from "vitest";
import { BurnRateCalculator, FastBurnDetector, SlowBurnDetector } from "./burnRate.js";

describe("BurnRateCalculator", () => {
  let calculator: BurnRateCalculator;

  beforeEach(() => {
    calculator = new BurnRateCalculator();
  });

  describe("Calculate Burn Rate", () => {
    it("should return 1.0 when actual equals target", () => {
      const rates = calculator.calculateBurnRate("slo_1", 0.999, 0.999);
      
      expect(rates["1h"]).toBeCloseTo(1.0);
      expect(rates["6h"]).toBeCloseTo(1.0);
      expect(rates["24h"]).toBeCloseTo(1.0);
    });

    it("should return > 1.0 when actual is below target", () => {
      const rates = calculator.calculateBurnRate("slo_1", 0.999, 0.995);
      
      expect(rates["1h"]).toBeGreaterThan(1.0);
      expect(rates["1h"]).toBeCloseTo(4, 0); // ~4x burn rate
    });

    it("should return < 1.0 when actual is above target", () => {
      const rates = calculator.calculateBurnRate("slo_1", 0.999, 0.9995);
      
      expect(rates["1h"]).toBeLessThan(1.0);
    });
  });

  describe("Calculate With Thresholds", () => {
    it("should determine severity based on thresholds", () => {
      const thresholds = { warning: 2, critical: 6 };
      const results = calculator.calculateWithThresholds("slo_1", 0.999, 0.995, thresholds);
      
      // 0.995 availability with 0.999 target = ~4x burn rate
      expect(results["1h"].severity).toBe("warning");
      expect(results["1h"].rate).toBeGreaterThan(2);
    });

    it("should mark critical when burn rate >= 6", () => {
      const thresholds = { warning: 2, critical: 6 };
      const rates = calculator.calculateWithThresholds("slo_1", 0.999, 0.990, thresholds);
      
      expect(rates["1h"].severity).toBe("critical");
    });
  });

  describe("Get Severity", () => {
    it("should return none for rate < warning", () => {
      const severity = calculator.getSeverity(1.5, { warning: 2, critical: 6 });
      expect(severity).toBe("none");
    });

    it("should return warning for rate >= warning", () => {
      const severity = calculator.getSeverity(2.5, { warning: 2, critical: 6 });
      expect(severity).toBe("warning");
    });

    it("should return critical for rate >= critical", () => {
      const severity = calculator.getSeverity(7, { warning: 2, critical: 6 });
      expect(severity).toBe("critical");
    });
  });

  describe("Fast Burn Detector", () => {
    let detector: FastBurnDetector;

    beforeEach(() => {
      detector = new FastBurnDetector();
    });

    it("should detect fast burn when budget consumed quickly", () => {
      const isFastBurn = detector.detectFastBurn("slo_1", 0.999, 0.990, 86.4);
      
      expect(isFastBurn).toBe(true);
    });

    it("should not detect fast burn when budget consumed slowly", () => {
      const isFastBurn = detector.detectFastBurn("slo_1", 0.999, 0.9995, 86.4);
      
      expect(isFastBurn).toBe(false);
    });

    it("should return fast burn alert", () => {
      const alert = detector.getFastBurnAlert(
        "slo_1",
        "gateway",
        0.999,
        0.990,
        86.4,
        6
      );

      expect(alert).toBeDefined();
      expect(alert?.severity).toBe("critical");
    });
  });

  describe("Slow Burn Detector", () => {
    let detector: SlowBurnDetector;

    beforeEach(() => {
      detector = new SlowBurnDetector();
    });

    it("should detect slow burn when budget consumed consistently", () => {
      const isSlowBurn = detector.detectSlowBurn("slo_1", 0.999, 0.998, 86.4, "rolling_24h");
      
      expect(isSlowBurn).toBe(true);
    });

    it("should not detect slow burn when budget consumed rapidly", () => {
      const isSlowBurn = detector.detectSlowBurn("slo_1", 0.999, 0.990, 86.4, "rolling_24h");
      
      expect(isSlowBurn).toBe(false);
    });

    it("should return slow burn alert", () => {
      const alert = detector.getSlowBurnAlert(
        "slo_1",
        "gateway",
        0.999,
        0.998,
        86.4,
        "rolling_24h",
        0.08
      );

      expect(alert).toBeDefined();
      expect(alert?.message).toContain("days");
    });
  });

  describe("Historical Burn Rate", () => {
    it("should store and retrieve historical burn rates", () => {
      calculator.calculateBurnRate("slo_1", 0.999, 0.9995);
      
      const rate = calculator.getHistoricalBurnRate("slo_1", "1h");
      expect(rate).toBeGreaterThan(0);
    });
  });
});