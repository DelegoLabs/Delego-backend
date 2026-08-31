/**
 * Tests for SLO Alert Manager
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SLOAlertManager } from "./alertManager.js";

describe("SLOAlertManager", () => {
  let manager: SLOAlertManager;

  beforeEach(() => {
    manager = new SLOAlertManager();
  });

  describe("Create Alert", () => {
    it("should create alert with all fields", () => {
      const alert = manager.createAlert(
        "slo_1",
        "gateway",
        "burn_rate_warning",
        "warning",
        "Burn rate exceeded threshold",
        { burnRate: 2.5, window: "1h" }
      );

      expect(alert.id).toBeDefined();
      expect(alert.sloId).toBe("slo_1");
      expect(alert.service).toBe("gateway");
      expect(alert.type).toBe("burn_rate_warning");
      expect(alert.severity).toBe("warning");
      expect(alert.active).toBe(true);
      expect(alert.metadata.burnRate).toBe(2.5);
    });
  });

  describe("Resolve Alert", () => {
    it("should resolve alert", () => {
      const alert = manager.createAlert("slo_1", "gateway", "burn_rate_warning", "warning", "Test");
      const resolved = manager.resolveAlert(alert.id);

      expect(resolved).toBe(true);
      expect(alert.active).toBe(false);
      expect(alert.resolvedAt).toBeDefined();
    });

    it("should return false for non-existent alert", () => {
      const resolved = manager.resolveAlert("nonexistent");
      expect(resolved).toBe(false);
    });
  });

  describe("Get Active Alerts", () => {
    it("should return active alerts for SLO", () => {
      manager.createAlert("slo_1", "gateway", "burn_rate_warning", "warning", "Test 1");
      manager.createAlert("slo_1", "gateway", "error_budget_critical", "critical", "Test 2");
      manager.resolveAlert(manager.getAllAlerts()[0].id); // Resolve first

      const activeAlerts = manager.getActiveAlerts("slo_1");
      
      expect(activeAlerts.length).toBe(1);
      expect(activeAlerts[0].type).toBe("error_budget_critical");
    });

    it("should return all active alerts when no SLO specified", () => {
      manager.createAlert("slo_1", "gateway", "burn_rate_warning", "warning", "Test 1");
      manager.createAlert("slo_2", "payments", "burn_rate_critical", "critical", "Test 2");

      const activeAlerts = manager.getActiveAlerts();
      expect(activeAlerts.length).toBe(2);
    });
  });

  describe("Check Thresholds", () => {
    it("should create warning alert for burn rate >= warning threshold", () => {
      const alerts = manager.checkThresholds(
        "slo_1",
        "gateway",
        { "1h": 2.5, "24h": 1.2 },
        { warning: 2, critical: 6 }
      );

      expect(alerts.length).toBe(1);
      expect(alerts[0].type).toBe("burn_rate_warning");
    });

    it("should create critical alert for burn rate >= critical threshold", () => {
      const alerts = manager.checkThresholds(
        "slo_1",
        "gateway",
        { "1h": 7, "24h": 3 },
        { warning: 2, critical: 6 }
      );

      expect(alerts.length).toBe(1);
      expect(alerts[0].type).toBe("burn_rate_critical");
      expect(alerts[0].severity).toBe("critical");
    });

    it("should create multiple alerts for multiple thresholds exceeded", () => {
      const alerts = manager.checkThresholds(
        "slo_1",
        "gateway",
        { "1h": 7, "24h": 7 },
        { warning: 2, critical: 6 }
      );

      expect(alerts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Check Error Budget", () => {
    it("should create alert for exhausted budget", () => {
      const alerts = manager.checkErrorBudget("slo_1", "gateway", "exhausted", {
        budget: 100,
        consumed: 100,
      });

      expect(alerts.length).toBe(1);
      expect(alerts[0].type).toBe("error_budget_exhausted");
    });

    it("should create alert for critical budget", () => {
      const alerts = manager.checkErrorBudget("slo_1", "gateway", "critical", {
        budget: 100,
        consumed: 80,
      });

      expect(alerts.length).toBe(1);
      expect(alerts[0].type).toBe("error_budget_critical");
    });

    it("should create alert for warning budget", () => {
      const alerts = manager.checkErrorBudget("slo_1", "gateway", "warning", {
        budget: 100,
        consumed: 50,
      });

      expect(alerts.length).toBe(1);
      expect(alerts[0].type).toBe("error_budget_warning");
    });
  });

  describe("Clear Alerts", () => {
    it("should clear all alerts for SLO", () => {
      manager.createAlert("slo_1", "gateway", "burn_rate_warning", "warning", "Test 1");
      manager.createAlert("slo_1", "gateway", "burn_rate_critical", "critical", "Test 2");

      manager.clearAlerts("slo_1");

      const alerts = manager.getActiveAlerts("slo_1");
      expect(alerts.length).toBe(0);
    });
  });

  describe("Get Alert Stats", () => {
    it("should return alert statistics", () => {
      manager.createAlert("slo_1", "gateway", "burn_rate_warning", "warning", "Test 1");
      manager.createAlert("slo_1", "gateway", "burn_rate_critical", "critical", "Test 2");
      manager.resolveAlert(manager.getAllAlerts()[0].id);

      const stats = manager.getAlertStats("slo_1");

      expect(stats.total).toBe(2);
      expect(stats.active).toBe(1);
      expect(stats.critical).toBe(1);
      expect(stats.warning).toBe(0);
    });
  });

  describe("Get Active Alert Types", () => {
    it("should return active alert types for SLO", () => {
      manager.createAlert("slo_1", "gateway", "burn_rate_warning", "warning", "Test 1");
      manager.createAlert("slo_1", "gateway", "error_budget_critical", "critical", "Test 2");

      const types = manager.getActiveAlertTypes("slo_1");
      expect(types.length).toBe(2);
      expect(types).toContain("burn_rate_warning");
      expect(types).toContain("error_budget_critical");
    });
  });
});