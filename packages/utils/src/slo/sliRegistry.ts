/**
 * SLI Registry - Service Level Indicator definitions and queries
 *
 * Provides standardized SLI definitions for all services with PromQL queries.
 */

import { createLogger } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SLIQuery {
  name: string;
  service: string;
  goodQuery: string;
  totalQuery: string;
}

export interface SLIResult {
  name: string;
  value: number;
  timestamp: string;
  labels: Record<string, string>;
}

export type SLIType = "availability" | "latency" | "quality" | "custom";

export interface SLIConfig {
  name: string;
  description: string;
  query: string;
  unit: SLIUnit;
  thresholds: SLIThresholds;
}

export type SLIUnit = "ratio" | "latency" | "throughput";

export interface SLIThresholds {
  good: number;
  excellent?: number;
  poor?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// SLI Registry
// ─────────────────────────────────────────────────────────────────────────────

export class SLIRegistry {
  private sliDefinitions = new Map<string, SLIConfig>();
  private defaultServices = ["gateway", "payments", "wallet", "notifications", "analytics", "fraud-detection"];

  constructor(defaultServices?: string[]) {
    if (defaultServices) {
      this.defaultServices = defaultServices;
    }
    this.registerDefaultSLIs();
  }

  registerSLI(config: SLIConfig): void {
    const key = `${config.name}`;
    this.sliDefinitions.set(key, config);
    log.info("SLI registered", { name: config.name, service: "all" });
  }

  getSLI(name: string): SLIConfig | undefined {
    return this.sliDefinitions.get(name);
  }

  listSLIs(service?: string): SLIConfig[] {
    if (!service) {
      return Array.from(this.sliDefinitions.values());
    }
    return Array.from(this.sliDefinitions.values()).filter((sli) => 
      sli.description.toLowerCase().includes(service.toLowerCase()) ||
      sli.name.toLowerCase().includes(service.toLowerCase())
    );
  }

  // ─── Default SLI Definitions ────────────────────────────────────────────

  private registerDefaultSLIs(): void {
    // ─── Availability SLIs ──────────────────────────────────────────────

    // Gateway availability
    this.registerSLI({
      name: "gateway_availability",
      description: "HTTP request success rate for gateway service",
      query: "1 - (sum(rate(http_requests_total{service=\"gateway\",status=~\"5..\"}[1h])) / sum(rate(http_requests_total{service=\"gateway\"}[1h])))",
      unit: "ratio",
      thresholds: { good: 0.999, excellent: 0.9999, poor: 0.99 },
    });

    // Payments availability
    this.registerSLI({
      name: "payments_availability",
      description: "HTTP request success rate for payments service",
      query: "1 - (sum(rate(http_requests_total{service=\"payments\",status=~\"5..\"}[1h])) / sum(rate(http_requests_total{service=\"payments\"}[1h])))",
      unit: "ratio",
      thresholds: { good: 0.999, excellent: 0.9999, poor: 0.99 },
    });

    // Wallet availability
    this.registerSLI({
      name: "wallet_availability",
      description: "HTTP request success rate for wallet service",
      query: "1 - (sum(rate(http_requests_total{service=\"wallet\",status=~\"5..\"}[1h])) / sum(rate(http_requests_total{service=\"wallet\"}[1h])))",
      unit: "ratio",
      thresholds: { good: 0.999, excellent: 0.9999, poor: 0.99 },
    });

    // Notifications availability
    this.registerSLI({
      name: "notifications_availability",
      description: "HTTP request success rate for notifications service",
      query: "1 - (sum(rate(http_requests_total{service=\"notifications\",status=~\"5..\"}[1h])) / sum(rate(http_requests_total{service=\"notifications\"}[1h])))",
      unit: "ratio",
      thresholds: { good: 0.995, excellent: 0.999, poor: 0.99 },
    });

    // ─── Latency SLIs ───────────────────────────────────────────────────

    // Gateway p95 latency
    this.registerSLI({
      name: "gateway_p95_latency",
      description: "95th percentile response latency for gateway",
      query: "histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{service=\"gateway\"}[1h])) by (le))",
      unit: "latency",
      thresholds: { good: 0.2, excellent: 0.1, poor: 0.5 }, // seconds
    });

    // Payments p95 latency
    this.registerSLI({
      name: "payments_p95_latency",
      description: "95th percentile response latency for payments",
      query: "histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{service=\"payments\"}[1h])) by (le))",
      unit: "latency",
      thresholds: { good: 0.3, excellent: 0.15, poor: 0.6 }, // seconds
    });

    // Wallet p95 latency
    this.registerSLI({
      name: "wallet_p95_latency",
      description: "95th percentile response latency for wallet",
      query: "histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{service=\"wallet\"}[1h])) by (le))",
      unit: "latency",
      thresholds: { good: 0.25, excellent: 0.12, poor: 0.5 }, // seconds
    });

    // ─── Quality SLIs ───────────────────────────────────────────────────

    // Error rate (all services)
    this.registerSLI({
      name: "error_rate",
      description: "Rate of HTTP 5xx errors across all services",
      query: "sum(rate(http_requests_total{status=~\"5..\"}[1h])) / sum(rate(http_requests_total[1h]))",
      unit: "ratio",
      thresholds: { good: 0.001, excellent: 0.0005, poor: 0.01 }, // error ratio
    });

    // Slow requests rate
    this.registerSLI({
      name: "slow_requests_rate",
      description: "Rate of requests exceeding SLO latency threshold",
      query: "sum(rate(http_request_duration_seconds_bucket{le=\"0.5\"}[1h])) / sum(rate(http_request_duration_seconds_count[1h]))",
      unit: "ratio",
      thresholds: { good: 0.99, excellent: 0.999, poor: 0.95 }, // percentage meeting latency target
    });

    // ─── Throughput SLIs ───────────────────────────────────────────────

    // Gateway throughput
    this.registerSLI({
      name: "gateway_throughput",
      description: "Requests per second for gateway",
      query: "sum(rate(http_requests_total{service=\"gateway\"}[1m]))",
      unit: "throughput",
      thresholds: { good: 1000, excellent: 5000, poor: 100 }, // RPS
    });

    // Payments throughput
    this.registerSLI({
      name: "payments_throughput",
      description: "Requests per second for payments",
      query: "sum(rate(http_requests_total{service=\"payments\"}[1m]))",
      unit: "throughput",
      thresholds: { good: 500, excellent: 1000, poor: 50 }, // RPS
    });
  }

  // ─── Service-Specific SLIs ────────────────────────────────────────────

  getServiceSLIs(service: string): SLIConfig[] {
    const serviceSLIs = this.listSLIs(service);
    
    // Add service-specific SLIs if not already registered
    const existingNames = new Set(serviceSLIs.map((s) => s.name));

    if (service === "gateway" && !existingNames.has("gateway_success_rate")) {
      this.registerSLI({
        name: "gateway_success_rate",
        description: "Success rate for gateway requests",
        query: `1 - (sum(rate(http_requests_total{service="gateway",status=~"5.."}[1h])) / sum(rate(http_requests_total{service="gateway"}[1h])))`,
        unit: "ratio",
        thresholds: { good: 0.999, excellent: 0.9999, poor: 0.99 },
      });
      serviceSLIs.push(this.getSLI("gateway_success_rate")!);
    }

    if (service === "payments" && !existingNames.has("payments_success_rate")) {
      this.registerSLI({
        name: "payments_success_rate",
        description: "Success rate for payments requests",
        query: `1 - (sum(rate(http_requests_total{service="payments",status=~"5.."}[1h])) / sum(rate(http_requests_total{service="payments"}[1h])))`,
        unit: "ratio",
        thresholds: { good: 0.999, excellent: 0.9999, poor: 0.99 },
      });
      serviceSLIs.push(this.getSLI("payments_success_rate")!);
    }

    return serviceSLIs;
  }

  // ─── Query Generation ─────────────────────────────────────────────────

  generatePromQLQuery(sliName: string, service: string, window: string): string {
    const sli = this.getSLI(sliName);
    if (!sli) {
      throw new Error(`SLI not found: ${sliName}`);
    }

    // Replace time window placeholder if present
    let query = sli.query.replace(/\[1h\]/g, `[${window}]`);

    return query;
  }

  // ─── SLI Evaluation ───────────────────────────────────────────────────

  evaluateSLI(sliName: string, service: string, value: number): {
    status: "pass" | "warning" | "fail";
    percentage: number;
  } {
    const sli = this.getSLI(sliName);
    if (!sli) {
      return { status: "fail", percentage: 0 };
    }

    const { good, excellent, poor } = sli.thresholds;

    if (sli.unit === "ratio" || sli.unit === "throughput") {
      if (value >= good) return { status: "pass", percentage: (value / good) * 100 };
      if (poor && value >= poor) return { status: "warning", percentage: (value / good) * 100 };
      return { status: "fail", percentage: (value / good) * 100 };
    } else if (sli.unit === "latency") {
      // For latency, lower is better (inverse of ratio)
      if (value <= good) return { status: "pass", percentage: (good / value) * 100 };
      if (poor && value <= poor) return { status: "warning", percentage: (good / value) * 100 };
      return { status: "fail", percentage: (good / value) * 100 };
    }

    return { status: "fail", percentage: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

const log = createLogger("utils:sli", process.env.LOG_LEVEL ?? "info");