/**
 * SLO Alert Manager
 *
 * Manages alerts for SLO violations, burn rate breaches, and error budget issues.
 */

import { createLogger } from "../logger.js";
import type { SLOAlert } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type AlertType = 
  | "burn_rate_warning"
  | "burn_rate_critical"
  | "error_budget_critical"
  | "error_budget_exhausted"
  | "fast_burn_warning"
  | "fast_burn_critical"
  | "slow_burn_warning"
  | "slow_burn_critical";

// ─────────────────────────────────────────────────────────────────────────────
// SLO Alert Manager
// ─────────────────────────────────────────────────────────────────────────────

export class SLOAlertManager {
  private alerts = new Map<string, SLOAlert>();
  private alertTypes = new Map<string, Set<AlertType>>();

  // ─── Create Alert ──────────────────────────────────────────────────────

  createAlert(
    sloId: string,
    service: string,
    type: AlertType,
    severity: "warning" | "critical",
    message: string,
    metadata: Record<string, unknown> = {}
  ): SLOAlert {
    const id = `alert_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    
    const alert: SLOAlert = {
      id,
      sloId,
      service,
      type,
      severity,
      message,
      active: true,
      createdAt: new Date().toISOString(),
      metadata,
    };

    this.alerts.set(id, alert);
    
    // Track alert types per SLO
    let types = this.alertTypes.get(sloId);
    if (!types) {
      types = new Set<AlertType>();
      this.alertTypes.set(sloId, types);
    }
    types.add(type);

    log.info("SLO alert created", { id, sloId, type, severity });
    return alert;
  }

  // ─── Resolve Alert ─────────────────────────────────────────────────────

  resolveAlert(alertId: string): boolean {
    const alert = this.alerts.get(alertId);
    if (!alert) return false;

    alert.active = false;
    alert.resolvedAt = new Date().toISOString();
    alert.updatedAt = new Date().toISOString();

    this.alerts.set(alertId, alert);
    log.info("SLO alert resolved", { id: alertId, type: alert.type });

    return true;
  }

  // ─── Get Active Alerts ─────────────────────────────────────────────────

  getActiveAlerts(sloId?: string): SLOAlert[] {
    const allAlerts = Array.from(this.alerts.values());
    
    if (sloId) {
      return allAlerts.filter((a) => a.active && a.sloId === sloId);
    }
    
    return allAlerts.filter((a) => a.active);
  }

  // ─── Get All Alerts ────────────────────────────────────────────────────

  getAllAlerts(sloId?: string): SLOAlert[] {
    if (sloId) {
      return Array.from(this.alerts.values()).filter((a) => a.sloId === sloId);
    }
    return Array.from(this.alerts.values());
  }

  // ─── Check Thresholds and Create Alerts ────────────────────────────────

  checkThresholds(
    sloId: string,
    service: string,
    burnRates: { [key: string]: number },
    thresholds: { warning: number; critical: number }
  ): SLOAlert[] {
    const newAlerts: SLOAlert[] = [];

    // Check each burn rate window
    if (burnRates["1h"] >= thresholds.critical) {
      const alert = this.createAlert(
        sloId,
        service,
        "burn_rate_critical",
        "critical",
        `Burn rate exceeded critical threshold (1h): ${burnRates["1h"].toFixed(2)}x`,
        { burnRate1h: burnRates["1h"], window: "1h" }
      );
      newAlerts.push(alert);
    } else if (burnRates["1h"] >= thresholds.warning) {
      const alert = this.createAlert(
        sloId,
        service,
        "burn_rate_warning",
        "warning",
        `Burn rate exceeded warning threshold (1h): ${burnRates["1h"].toFixed(2)}x`,
        { burnRate1h: burnRates["1h"], window: "1h" }
      );
      newAlerts.push(alert);
    }

    // Check 24h burn rate for slow burn detection
    if (burnRates["24h"] >= thresholds.critical) {
      const alert = this.createAlert(
        sloId,
        service,
        "slow_burn_critical",
        "critical",
        `Slow burn detected (24h): ${burnRates["24h"].toFixed(2)}x`,
        { burnRate24h: burnRates["24h"], window: "24h" }
      );
      newAlerts.push(alert);
    } else if (burnRates["24h"] >= thresholds.warning) {
      const alert = this.createAlert(
        sloId,
        service,
        "slow_burn_warning",
        "warning",
        `Slow burn detected (24h): ${burnRates["24h"].toFixed(2)}x`,
        { burnRate24h: burnRates["24h"], window: "24h" }
      );
      newAlerts.push(alert);
    }

    return newAlerts;
  }

  // ─── Check Error Budget Status ─────────────────────────────────────────

  checkErrorBudget(
    sloId: string,
    service: string,
    status: "healthy" | "warning" | "critical" | "exhausted",
    metadata: Record<string, unknown> = {}
  ): SLOAlert[] {
    const newAlerts: SLOAlert[] = [];

    if (status === "exhausted") {
      const alert = this.createAlert(
        sloId,
        service,
        "error_budget_exhausted",
        "critical",
        "Error budget exhausted!",
        metadata
      );
      newAlerts.push(alert);
    } else if (status === "critical") {
      const alert = this.createAlert(
        sloId,
        service,
        "error_budget_critical",
        "critical",
        "Error budget approaching exhaustion",
        metadata
      );
      newAlerts.push(alert);
    } else if (status === "warning") {
      const alert = this.createAlert(
        sloId,
        service,
        "error_budget_warning",
        "warning",
        "Error budget consumption elevated",
        metadata
      );
      newAlerts.push(alert);
    }

    return newAlerts;
  }

  // ─── Clear Alerts for SLO ──────────────────────────────────────────────

  clearAlerts(sloId: string): void {
    for (const [id, alert] of this.alerts) {
      if (alert.sloId === sloId) {
        alert.active = false;
        alert.resolvedAt = new Date().toISOString();
      }
    }
    this.alertTypes.delete(sloId);
  }

  // ─── Get Alert Statistics ──────────────────────────────────────────────

  getAlertStats(sloId?: string): {
    total: number;
    active: number;
    critical: number;
    warning: number;
  } {
    const allAlerts = this.getAllAlerts(sloId);
    
    const activeAlerts = allAlerts.filter((a) => a.active);
    
    return {
      total: allAlerts.length,
      active: activeAlerts.length,
      critical: activeAlerts.filter((a) => a.severity === "critical").length,
      warning: activeAlerts.filter((a) => a.severity === "warning").length,
    };
  }

  // ─── Get Active Alert Types per SLO ────────────────────────────────────

  getActiveAlertTypes(sloId: string): AlertType[] {
    return Array.from(this.alertTypes.get(sloId) || []);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

const log = createLogger("utils:slo-alert", process.env.LOG_LEVEL ?? "info");