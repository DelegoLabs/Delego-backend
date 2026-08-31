/**
 * SLO Manager
 *
 * Main orchestrator for SLO management, combining SLI, budget, and alerting.
 */

import { createLogger } from "../logger.js";
import { SLIRegistry } from "./sliRegistry.js";
import { ErrorBudgetTracker } from "./errorBudget.js";
import { BurnRateCalculator, FastBurnDetector, SlowBurnDetector } from "./burnRate.js";
import { SLOAlertManager } from "./alertManager.js";
import type {
  SLOConfig,
  SLIConfig,
  SLO,
  SLI,
  ErrorBudgetPolicy,
  SLOMetrics,
  ServiceSLOMetrics,
  SLOReport,
  SLOStatus,
  BurnRateThresholds,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// SLO Manager
// ─────────────────────────────────────────────────────────────────────────────

export class SLOManager {
  private sloConfigs = new Map<string, SLOConfig>();
  private sliRegistry: SLIRegistry;
  private errorBudgetTracker: ErrorBudgetTracker;
  private burnRateCalculator: BurnRateCalculator;
  private fastBurnDetector: FastBurnDetector;
  private slowBurnDetector: SlowBurnDetector;
  private alertManager: SLOAlertManager;

  constructor(defaultServices?: string[]) {
    this.sliRegistry = new SLIRegistry(defaultServices);
    this.errorBudgetTracker = new ErrorBudgetTracker();
    this.burnRateCalculator = new BurnRateCalculator();
    this.fastBurnDetector = new FastBurnDetector();
    this.slowBurnDetector = new SlowBurnDetector();
    this.alertManager = new SLOAlertManager();
  }

  // ─── Configuration ─────────────────────────────────────────────────────

  registerSLO(config: SLOConfig): void {
    this.sloConfigs.set(config.id, config);
    log.info("SLO registered", { id: config.id, service: config.service, name: config.name });
  }

  getSLO(id: string): SLOConfig | undefined {
    return this.sloConfigs.get(id);
  }

  listSLOs(service?: string): SLOConfig[] {
    if (!service) {
      return Array.from(this.sloConfigs.values());
    }
    return Array.from(this.sloConfigs.values()).filter((slo) => slo.service === service);
  }

  // ─── Register Service SLOs ─────────────────────────────────────────────

  registerServiceSLOs(service: string, policies?: Record<string, ErrorBudgetPolicy>): void {
    const sliConfigs = this.sliRegistry.getServiceSLIs(service);

    sliConfigs.forEach((sli) => {
      const sloId = `${service}_${sli.name}`;

      // Determine burn rate thresholds
      let burnRateThresholds: BurnRateThresholds = { warning: 2, critical: 6 };
      if (policies?.[sli.name]) {
        burnRateThresholds = {
          warning: policies[sli.name].burnRateWarningThreshold,
          critical: policies[sli.name].burnRateCriticalThreshold,
        };
      }

      const config: SLOConfig = {
        id: sloId,
        service,
        name: sli.name,
        sliName: sli.name,
        target: this.getSLOTarget(sli.name),
        window: "rolling_24h",
        alerting: {
          burnRateThresholds,
        },
        policy: policies?.[sli.name],
      };

      this.registerSLO(config);
    });
  }

  // ─── SLI Targets by Type ───────────────────────────────────────────────

  private getSLOTarget(sliName: string): number {
    const targets: Record<string, number> = {
      availability: 0.999,
      success_rate: 0.999,
      error_rate: 0.999,
      latency: 0.99,
      p95_latency: 0.99,
      throughput: 0.99,
    };

    for (const [key, target] of Object.entries(targets)) {
      if (sliName.toLowerCase().includes(key)) {
        return target;
      }
    }

    return 0.999; // Default to 99.9% SLO
  }

  // ─── Evaluate SLO ──────────────────────────────────────────────────────

  evaluateSLO(
    sloId: string,
    actualAvailability: number,
    now: Date = new Date()
  ): SLOMetrics {
    const slo = this.getSLO(sloId);
    if (!slo) {
      throw new Error(`SLO not found: ${sloId}`);
    }

    const budgetState = this.errorBudgetTracker.trackConsumption(
      sloId,
      slo.service,
      slo.target,
      slo.window,
      actualAvailability,
      now
    );

    const burnRates = this.burnRateCalculator.calculateBurnRate(
      sloId,
      slo.target,
      actualAvailability,
      now
    );

    // Check for alerts
    const alertThresholds = slo.alerting.burnRateThresholds;
    const newAlerts = this.alertManager.checkThresholds(
      sloId,
      slo.service,
      burnRates,
      { warning: alertThresholds.warning, critical: alertThresholds.critical }
    );

    // Check error budget status
    this.alertManager.checkErrorBudget(
      sloId,
      slo.service,
      budgetState.status.current,
      { budget: budgetState.budget, consumed: budgetState.consumed }
    );

    // Check fast/slow burn
    const fastBurnAlert = this.fastBurnDetector.getFastBurnAlert(
      sloId,
      slo.service,
      slo.target,
      actualAvailability,
      budgetState.budget,
      burnRates["1h"]
    );

    if (fastBurnAlert) {
      this.alertManager.createAlert(
        sloId,
        slo.service,
        fastBurnAlert.alertType as any,
        fastBurnAlert.severity,
        fastBurnAlert.message,
        fastBurnAlert.metadata
      );
    }

    // Check slow burn
    const slowBurnAlert = this.slowBurnDetector.getSlowBurnAlert(
      sloId,
      slo.service,
      slo.target,
      actualAvailability,
      budgetState.budget,
      slo.window,
      this.slowBurnDetector.estimateConsumptionRate(actualAvailability, slo.target, slo.window)
    );

    if (slowBurnAlert) {
      this.alertManager.createAlert(
        sloId,
        slo.service,
        slowBurnAlert.alertType as any,
        slowBurnAlert.severity,
        slowBurnAlert.message,
        slowBurnAlert.metadata
      );
    }

    // Determine overall status
    let status: SLOStatus = "healthy";
    if (budgetState.status.current === "exhausted") {
      status = "exhausted";
    } else if (budgetState.status.current === "critical") {
      status = "critical";
    } else if (budgetState.status.current === "warning") {
      status = "warning";
    }

    // Count active incidents (alerts)
    const alertStats = this.alertManager.getAlertStats(sloId);

    return {
      sloId,
      service: slo.service,
      sliName: slo.sliName,
      target: slo.target,
      window: slo.window,
      actual: actualAvailability,
      errorBudgetRemaining: budgetState.remaining,
      burnRate,
      status,
      lastUpdated: now.toISOString(),
      incidents: alertStats.active,
    };
  }

  // ─── Get Service Metrics ───────────────────────────────────────────────

  getServiceMetrics(service: string, now: Date = new Date()): ServiceSLOMetrics {
    const slos = this.listSLOs(service);
    
    const sloMetrics: SLOMetrics[] = [];
    let overallStatus: SLOStatus = "healthy";
    let hasCritical = false;
    let hasWarning = false;

    slos.forEach((slo) => {
      // Get actual availability from SLI (simulated)
      const actualAvailability = this.getActualAvailability(slo.sliName, service);
      
      const metrics = this.evaluateSLO(slo.id, actualAvailability, now);
      sloMetrics.push(metrics);

      if (metrics.status === "critical" || metrics.status === "exhausted") {
        hasCritical = true;
      } else if (metrics.status === "warning") {
        hasWarning = true;
      }
    });

    if (hasCritical) {
      overallStatus = "exhausted";
    } else if (hasWarning) {
      overallStatus = "warning";
    }

    return {
      service,
      slos: sloMetrics,
      overallHealth: this.getSLOHealthStatus(overallStatus),
      lastUpdated: now.toISOString(),
    };
  }

  // ─── Get SLO Report ────────────────────────────────────────────────────

  generateSLOReport(service: string, period: { start: string; end: string }): SLOReport {
    const slos = this.listSLOs(service);
    const now = new Date(period.end);
    
    const sloReports = slos.map((slo) => {
      const actualAvailability = this.getActualAvailability(slo.sliName, service);
      const metrics = this.evaluateSLO(slo.id, actualAvailability, now);
      
      return {
        name: slo.name,
        target: slo.target,
        actual: actualAvailability,
        errorBudgetRemaining: metrics.errorBudgetRemaining,
        burnRate: metrics.burnRate,
        incidents: metrics.incidents,
      };
    });

    // Determine overall health
    let overallHealth: "healthy" | "degraded" | "critical" = "healthy";
    const hasCritical = sloReports.some((s) => 
      s.actual < s.target * 0.9 // More than 10% below target
    );
    const hasWarning = sloReports.some((s) => 
      s.actual < s.target * 0.95 && s.actual >= s.target * 0.9
    );

    if (hasCritical) {
      overallHealth = "critical";
    } else if (hasWarning) {
      overallHealth = "degraded";
    }

    return {
      service,
      period,
      slos: sloReports,
      overallHealth,
    };
  }

  // ─── Helper Methods ────────────────────────────────────────────────────

  private getActualAvailability(sliName: string, service: string): number {
    // In production, this would query Prometheus
    // For now, return a simulated value based on SLI type
    
    if (sliName.includes("availability") || sliName.includes("success_rate")) {
      // Simulate 99.95% availability
      return 0.9995;
    }
    
    if (sliName.includes("latency")) {
      // Simulate 99.5% meeting latency target
      return 0.995;
    }
    
    if (sliName.includes("throughput")) {
      // Simulate 99% meeting throughput target
      return 0.99;
    }

    return 0.999;
  }

  private getSLOHealthStatus(status: SLOStatus): "healthy" | "degraded" | "critical" {
    if (status === "exhausted" || status === "critical") {
      return "critical";
    }
    if (status === "warning") {
      return "degraded";
    }
    return "healthy";
  }

  // ─── Utility Methods ───────────────────────────────────────────────────

  getAlerts(sloId?: string) {
    return this.alertManager.getActiveAlerts(sloId);
  }

  getBudgetState(sloId: string) {
    return this.errorBudgetTracker.getBudgetState(sloId);
  }

  getBurnRate(sloId: string, window: string): number | undefined {
    return this.burnRateCalculator.getHistoricalBurnRate(sloId, window);
  }

  clearAlerts(sloId: string) {
    this.alertManager.clearAlerts(sloId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

const log = createLogger("utils:slo-manager", process.env.LOG_LEVEL ?? "info");