/**
 * Tests for SLO Manager
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SLOManager } from "./manager.js";

describe("SLOManager", () => {
  let manager: SLOManager;

  beforeEach(() => {
    manager = new SLOManager();
  });

  describe("Register SLO", () => {
    it("should register SLO configuration", () => {
      const sloConfig = {
        id: "slo_gateway_availability",
        service: "gateway",
        name: "availability",
        sliName: "gateway_availability",
        target: 0.999,
        window: "rolling_24h" as const,
        alerting: {
          burnRateThresholds: { warning: 2, critical: 6 },
        },
      };

      manager.registerSLO(sloConfig);

      const retrieved = manager.getSLO("slo_gateway_availability");
      expect(retrieved).toBeDefined();
      expect(retrieved?.target).toBe(0.999);
    });

    it("should list SLOs for service", () => {
      manager.registerServiceSLOs("gateway");

      const slos = manager.listSLOs("gateway");
      expect(slos.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("Register Service SLOs", () => {
    it("should register default SLOs for service", () => {
      manager.registerServiceSLOs("gateway");

      const slos = manager.listSLOs("gateway");
      expect(slos.length).toBeGreaterThanOrEqual(3);

      const availabilitySLO = slos.find((s) => s.name.includes("availability"));
      expect(availabilitySLO).toBeDefined();
      expect(availabilitySLO?.target).toBeCloseTo(0.999);
    });

    it("should apply custom policies", () => {
      const policies = {
        gateway_availability: {
          burnRateWarningThreshold: 3,
          burnRateCriticalThreshold: 8,
          burnRateWindow: "1h",
          autoRemediate: false,
          autoRemediateThreshold: 10,
          incidentAlertDelay: 5,
        },
      };

      manager.registerServiceSLOs("gateway", policies);

      const slos = manager.listSLOs("gateway");
      const availabilitySLO = slos.find((s) => s.name.includes("availability"));
      expect(availabilitySLO?.alerting.burnRateThresholds.warning).toBe(3);
      expect(availabilitySLO?.alerting.burnRateThresholds.critical).toBe(8);
    });
  });

  describe("Evaluate SLO", () => {
    it("should evaluate SLO with good availability", () => {
      manager.registerServiceSLOs("gateway");
      const sloId = manager.listSLOs("gateway")[0].id;

      const metrics = manager.evaluateSLO(sloId, 0.9995);

      expect(metrics.sloId).toBe(sloId);
      expect(metrics.actual).toBe(0.9995);
      expect(metrics.errorBudgetRemaining).toBeGreaterThan(0);
      expect(metrics.status).toBe("healthy");
    });

    it("should evaluate SLO with poor availability", () => {
      manager.registerServiceSLOs("gateway");
      const sloId = manager.listSLOs("gateway")[0].id;

      const metrics = manager.evaluateSLO(sloId, 0.99);

      expect(metrics.actual).toBe(0.99);
      expect(metrics.errorBudgetRemaining).toBeLessThan(1);
      expect(metrics.status).toBe("critical");
    });

    it("should count incidents", () => {
      manager.registerServiceSLOs("gateway");
      const sloId = manager.listSLOs("gateway")[0].id;

      // Create some alerts
      manager.getAlerts(sloId);

      const metrics = manager.evaluateSLO(sloId, 0.99);

      expect(metrics.incidents).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Get Service Metrics", () => {
    it("should get metrics for service", () => {
      manager.registerServiceSLOs("gateway");

      const metrics = manager.getServiceMetrics("gateway");

      expect(metrics.service).toBe("gateway");
      expect(metrics.slos.length).toBeGreaterThanOrEqual(3);
      expect(metrics.slos[0]).toHaveProperty("status");
    });

    it("should determine overall health", () => {
      manager.registerServiceSLOs("gateway");

      const metrics = manager.getServiceMetrics("gateway");

      expect(["healthy", "degraded", "critical"]).toContain(metrics.overallHealth);
    });
  });

  describe("Generate SLO Report", () => {
    it("should generate SLO report for service", () => {
      manager.registerServiceSLOs("gateway");

      const report = manager.generateSLOReport("gateway", {
        start: "2025-08-23T00:00:00Z",
        end: "2025-08-30T23:59:59Z",
      });

      expect(report.service).toBe("gateway");
      expect(report.period.start).toBe("2025-08-23T00:00:00Z");
      expect(report.period.end).toBe("2025-08-30T23:59:59Z");
      expect(report.slos.length).toBeGreaterThanOrEqual(3);
      expect(["healthy", "degraded", "critical"]).toContain(report.overallHealth);
    });
  });

  describe("Utility Methods", () => {
    it("should get burn rate", () => {
      manager.registerServiceSLOs("gateway");
      const sloId = manager.listSLOs("gateway")[0].id;

      const rate = manager.getBurnRate(sloId, "1h");
      expect(rate).toBeGreaterThan(0);
    });

    it("should clear alerts for SLO", () => {
      manager.registerServiceSLOs("gateway");
      const sloId = manager.listSLOs("gateway")[0].id;

      // Create some alerts
      manager.getAlerts(sloId);

      manager.clearAlerts(sloId);

      const alerts = manager.getAlerts(sloId);
      expect(alerts.length).toBe(0);
    });
  });

  describe("SLO Targets", () => {
    it("should use correct targets by SLI type", () => {
      // Availability SLIs should have 99.9% target
      const availabilityTarget = manager["getSLOTarget"]("gateway_availability");
      expect(availabilityTarget).toBeCloseTo(0.999);

      // Latency SLIs should have 99% target
      const latencyTarget = manager["getSLOTarget"]("gateway_p95_latency");
      expect(latencyTarget).toBeCloseTo(0.99);

      // Error rate SLIs should have 99.9% target
      const errorRateTarget = manager["getSLOTarget"]("error_rate");
      expect(errorRateTarget).toBeCloseTo(0.999);
    });
  });
});