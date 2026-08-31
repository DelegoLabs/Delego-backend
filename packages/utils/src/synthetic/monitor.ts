/**
 * Synthetic Monitor Implementation
 *
 * Main orchestrator for synthetic monitoring checks.
 */

import { createLogger } from "../logger.js";
import { CheckExecutor } from "./executor.js";
import { CheckResultStore } from "./store.js";
import { CheckScheduler } from "./scheduler.js";
import { StatusPageIntegration } from "./statusPage.js";
import { PerformanceBenchmarks } from "./benchmarks.js";
import { MaintenanceWindowManager } from "./maintenance.js";
import type {
  SyntheticCheck,
  CheckResult,
  SyntheticMetrics,
  CheckExecutionResult,
  Incident,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_LOCATIONS = [
  "us-east-1",      // US East (N. Virginia)
  "us-west-2",      // US West (Oregon)
  "eu-west-1",      // EU (Ireland)
  "eu-central-1",   // EU (Frankfurt)
  "ap-south-1",     // Asia Pacific (Mumbai)
  "ap-northeast-1", // Asia Pacific (Tokyo)
  "ap-southeast-1", // Asia Pacific (Singapore)
  "sa-east-1",      // South America (Sao Paulo)
  "ca-central-1",   // Canada (Central)
  "af-south-1",     // Africa (Cape Town)
  "me-south-1",     // Middle East (Bahrain)
  "eu-north-1",     // EU (Stockholm)
];

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic Monitor
// ─────────────────────────────────────────────────────────────────────────────

export class SyntheticMonitor {
  private checks = new Map<string, SyntheticCheck>();
  private executor: CheckExecutor;
  private store: CheckResultStore;
  private scheduler: CheckScheduler;
  private statusPage: StatusPageIntegration | null;
  private benchmarks: PerformanceBenchmarks;
  private maintenanceManager: MaintenanceWindowManager;
  private incidents = new Map<string, Incident[]>();

  constructor(options: {
    locations?: string[];
    store?: CheckResultStore;
    scheduler?: CheckScheduler;
    statusPage?: StatusPageIntegration;
  } = {}) {
    this.executor = new CheckExecutor({
      locations: options.locations || DEFAULT_LOCATIONS,
    });

    this.store = options.store || new CheckResultStore();
    this.scheduler = options.scheduler || new CheckScheduler();
    this.statusPage = options.statusPage || null;
    this.benchmarks = new PerformanceBenchmarks();
    this.maintenanceManager = new MaintenanceWindowManager();

    this.setupDefaultChecks();
  }

  // ─── Check Configuration ────────────────────────────────────────────────

  private setupDefaultChecks(): void {
    // Gateway health check
    this.addCheck({
      id: "gateway-health",
      name: "Gateway Health",
      type: "http",
      frequency: 60, // 1 minute
      locations: DEFAULT_LOCATIONS.slice(0, 5),
      request: {
        url: "https://api.example.com/health",
        method: "GET",
        headers: { "Accept": "application/json" },
      },
      assertions: [
        { type: "status_code", operator: "eq", value: "200" },
        { type: "response_time", operator: "lt", value: "500" },
      ],
      alerting: {
        enabled: true,
        threshold: 3,
        notifyOnRecovery: true,
      },
    });

    // Payments endpoint
    this.addCheck({
      id: "payments-checkout",
      name: "Payments Checkout",
      type: "http",
      frequency: 120, // 2 minutes
      locations: DEFAULT_LOCATIONS,
      request: {
        url: "https://api.example.com/payments/checkout",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 100, currency: "USD" }),
      },
      assertions: [
        { type: "status_code", operator: "eq", value: "200" },
        { type: "json_path", operator: "contains", value: "payment_id" },
      ],
      alerting: {
        enabled: true,
        threshold: 2,
        notifyOnRecovery: true,
      },
    });

    // Wallet balance endpoint
    this.addCheck({
      id: "wallet-balance",
      name: "Wallet Balance",
      type: "http",
      frequency: 120,
      locations: DEFAULT_LOCATIONS,
      request: {
        url: "https://api.example.com/wallet/balance",
        method: "GET",
        headers: { "Accept": "application/json" },
      },
      assertions: [
        { type: "status_code", operator: "eq", value: "200" },
        { type: "response_time", operator: "lt", value: "300" },
      ],
      alerting: {
        enabled: true,
        threshold: 3,
        notifyOnRecovery: true,
      },
    });
  }

  addCheck(check: SyntheticCheck): void {
    this.checks.set(check.id, check);
    log.info("Synthetic check added", { id: check.id, name: check.name, type: check.type });
  }

  getCheck(id: string): SyntheticCheck | undefined {
    return this.checks.get(id);
  }

  listChecks(): SyntheticCheck[] {
    return Array.from(this.checks.values());
  }

  removeCheck(id: string): boolean {
    return this.checks.delete(id);
  }

  // ─── Check Execution ────────────────────────────────────────────────────

  async runCheck(checkId: string, location?: string): Promise<CheckResult[]> {
    const check = this.checks.get(checkId);
    if (!check) {
      throw new Error(`Check not found: ${checkId}`);
    }

    // Check maintenance windows
    if (!this.maintenanceManager.isCheckActive(checkId)) {
      log.info("Check skipped due to maintenance", { id: checkId });
      return [];
    }

    const locations = location ? [location] : check.locations;

    const results: CheckResult[] = [];
    const now = new Date().toISOString();

    for (const loc of locations) {
      const executionResult = await this.executor.execute(check, loc);
      
      // Convert execution result to standard result
      const result: CheckResult = {
        checkId: check.id,
        location: loc,
        timestamp: now,
        status: executionResult.status,
        responseTime: executionResult.responseTime,
        statusCode: executionResult.statusCode,
        assertions: executionResult.assertions,
        error: executionResult.error,
      };

      results.push(result);
      
      // Store result
      await this.store.storeResult(result);
    }

    // Update incidents
    this.updateIncidents(checkId, results);

    // Update benchmarks
    this.benchmarks.recordResults(checkId, results);

    // Check status page integration
    if (this.statusPage) {
      await this.statusPage.updateStatus(checkId, results);
    }

    return results;
  }

  // ─── Scheduled Execution ────────────────────────────────────────────────

  async runAllChecks(locations?: string[]): Promise<Record<string, CheckResult[]>> {
    const results: Record<string, CheckResult[]> = {};

    for (const check of this.checks.values()) {
      try {
        const checkResults = await this.runCheck(check.id, locations?.[0]);
        results[check.id] = checkResults;
      } catch (err) {
        log.error("Check execution failed", { id: check.id, error: (err as Error).message });
      }
    }

    return results;
  }

  // ─── Metrics Generation ─────────────────────────────────────────────────

  generateMetrics(checkId: string, period: { start: string; end: string }): SyntheticMetrics {
    const results = this.store.getResults(checkId, period);

    const byLocation: Record<string, { availability: number; avgResponseTime: number }> = {};

    // Group by location
    const locationResults = new Map<string, CheckResult[]>();
    for (const result of results) {
      const locResults = locationResults.get(result.location) || [];
      locResults.push(result);
      locationResults.set(result.location, locResults);
    }

    // Calculate per-location metrics
    for (const [location, locResults] of locationResults) {
      const successCount = locResults.filter((r) => r.status === "success").length;
      const availability = locResults.length > 0 ? successCount / locResults.length : 0;

      const responseTimes = locResults.map((r) => r.responseTime);
      const avgResponseTime = responseTimes.length > 0
        ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
        : 0;

      byLocation[location] = { availability, avgResponseTime };
    }

    // Calculate overall metrics
    const responseTimes = results.map((r) => r.responseTime);
    const avgResponseTime = responseTimes.length > 0
      ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
      : 0;

    const sortedTimes = [...responseTimes].sort((a, b) => a - b);
    const p95Index = Math.floor(sortedTimes.length * 0.95);
    const p95ResponseTime = sortedTimes[p95Index] || 0;

    const successCount = results.filter((r) => r.status === "success").length;
    const availability = results.length > 0 ? successCount / results.length : 0;

    // Identify incidents
    const incidents = this.identifyIncidents(checkId, results);

    return {
      checkId,
      period,
      availability,
      avgResponseTime,
      p95ResponseTime,
      byLocation,
      incidents,
    };
  }

  // ─── Incident Management ────────────────────────────────────────────────

  private updateIncidents(checkId: string, results: CheckResult[]): void {
    const check = this.checks.get(checkId);
    if (!check?.alerting.enabled) return;

    const threshold = check.alerting.threshold;

    // Group results by location
    const locationResults = new Map<string, CheckResult[]>();
    for (const result of results) {
      const locResults = locationResults.get(result.location) || [];
      locResults.push(result);
      locationResults.set(result.location, locResults);
    }

    // Check for incidents
    for (const [location, locResults] of locationResults) {
      // Find consecutive failures
      let consecutiveFailures = 0;
      let incident: Incident | null = null;

      for (const result of locResults) {
        if (result.status !== "success") {
          consecutiveFailures++;
          
          if (!incident) {
            incident = {
              id: `incident_${checkId}_${location}_${Date.now()}`,
              checkId,
              location,
              startTime: result.timestamp,
              failureCount: 1,
              status: "active",
            };
          } else {
            incident.failureCount++;
          }
        } else {
          if (incident && consecutiveFailures >= threshold) {
            incident.endTime = result.timestamp;
            incident.duration = new Date(incident.endTime).getTime() - new Date(incident.startTime).getTime();
            incident.status = "resolved";
            
            let incidents = this.incidents.get(checkId) || [];
            incidents.push(incident);
            this.incidents.set(checkId, incidents);
          }
          
          consecutiveFailures = 0;
          incident = null;
        }
      }
    }
  }

  private identifyIncidents(checkId: string, results: CheckResult[]): Array<{ start: string; end?: string; duration: number; locations: string[] }> {
    const incidents: Array<{ start: string; end?: string; duration: number; locations: string[] }> = [];

    const checkIncidents = this.incidents.get(checkId) || [];
    
    for (const incident of checkIncidents) {
      if (incident.status === "active") {
        incidents.push({
          start: incident.startTime,
          duration: new Date().getTime() - new Date(incident.startTime).getTime(),
          locations: [incident.location],
        });
      } else {
        incidents.push({
          start: incident.startTime,
          end: incident.endTime,
          duration: incident.duration,
          locations: [incident.location],
        });
      }
    }

    return incidents;
  }

  getIncidents(checkId: string): Incident[] {
    return this.incidents.get(checkId) || [];
  }

  // ─── Performance Benchmarks ─────────────────────────────────────────────

  getBenchmarks(checkId: string, window: string): PerformanceMetrics | null {
    return this.benchmarks.getBenchmarks(checkId, window);
  }

  // ─── Status Page Integration ────────────────────────────────────────────

  async updateStatusPage(): Promise<void> {
    if (this.statusPage) {
      await this.statusPage.updateAllStatuses();
    }
  }

  // ─── Utility Methods ────────────────────────────────────────────────────

  getStore(): CheckResultStore {
    return this.store;
  }

  getScheduler(): CheckScheduler {
    return this.scheduler;
  }

  getMaintenanceManager(): MaintenanceWindowManager {
    return this.maintenanceManager;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

const log = createLogger("utils:synthetic", process.env.LOG_LEVEL ?? "info");