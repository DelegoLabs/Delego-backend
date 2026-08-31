/**
 * Status Page Integration
 *
 * Integrates synthetic monitoring results with status pages.
 */

import { createLogger } from "../logger.js";
import type { CheckResult, SyntheticCheck } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Status Page Integration
// ─────────────────────────────────────────────────────────────────────────────

export class StatusPageIntegration {
  private checks = new Map<string, SyntheticCheck>();
  private pageId: string;
  private apiKey: string;
  private apiUrl: string;
  private componentStatuses = new Map<string, "operational" | "degraded_performance" | "partial_outage" | "major_outage">();

  constructor(options: {
    pageId: string;
    apiKey: string;
    apiUrl?: string;
  }) {
    this.pageId = options.pageId;
    this.apiKey = options.apiKey;
    this.apiUrl = options.apiUrl || "https://api.statuspage.io/v1";
  }

  // ─── Check Registration ─────────────────────────────────────────────────

  registerCheck(check: SyntheticCheck): void {
    this.checks.set(check.id, check);
    log.info("Check registered for status page", { id: check.id, name: check.name });
  }

  // ─── Status Update ──────────────────────────────────────────────────────

  async updateStatus(checkId: string, results: CheckResult[]): Promise<void> {
    const check = this.checks.get(checkId);
    if (!check) return;

    // Determine status based on results
    const successRate = results.filter((r) => r.status === "success").length / results.length;
    
    let status: "operational" | "degraded_performance" | "partial_outage" | "major_outage" = "operational";

    if (successRate < 0.99) {
      status = "major_outage";
    } else if (successRate < 0.999) {
      status = "partial_outage";
    } else if (successRate < 1) {
      status = "degraded_performance";
    }

    // Update component status
    await this.updateComponentStatus(check.id, check.name, status);
    this.componentStatuses.set(check.id, status);

    log.info("Status page updated", {
      checkId,
      status,
      successRate: (successRate * 100).toFixed(2) + "%",
    });
  }

  async updateAllStatuses(): Promise<void> {
    log.info("Updating all status page components");

    for (const check of this.checks.values()) {
      // Get recent results for this check
      // In production, this would query the store
      const mockResults: CheckResult[] = [
        {
          checkId: check.id,
          location: "us-east-1",
          timestamp: new Date().toISOString(),
          status: "success",
          responseTime: 100,
          statusCode: 200,
          assertions: [{ passed: true, actual: "200", expected: "200" }],
        },
      ];

      await this.updateStatus(check.id, mockResults);
    }
  }

  // ─── Component Status Management ────────────────────────────────────────

  private async updateComponentStatus(
    componentId: string,
    componentName: string,
    status: "operational" | "degraded_performance" | "partial_outage" | "major_outage"
  ): Promise<void> {
    try {
      const response = await fetch(`${this.apiUrl}/pages/${this.pageId}/components/${componentId}`, {
        method: "PATCH",
        headers: {
          "Authorization": `OAuth ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          component: {
            status,
            name: componentName,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Status page API error: ${response.status}`);
      }

      log.debug("Component status updated", {
        componentId,
        status,
      });
    } catch (error) {
      log.error("Failed to update component status", {
        componentId,
        error: (error as Error).message,
      });
    }
  }

  // ─── Incident Reporting ─────────────────────────────────────────────────

  async createIncident(
    checkId: string,
    name: string,
    status: "investigating" | "identified" | "monitoring" | "resolved",
    message?: string
  ): Promise<void> {
    try {
      const response = await fetch(`${this.apiUrl}/pages/${this.pageId}/incidents`, {
        method: "POST",
        headers: {
          "Authorization": `OAuth ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          incident: {
            name,
            status,
            body: message,
            component_ids: [checkId],
            maintainers: [],
            impact_override: status === "resolved" ? "none" : "minor",
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Status page API error: ${response.status}`);
      }

      log.info("Incident created", { checkId, name, status });
    } catch (error) {
      log.error("Failed to create incident", {
        checkId,
        error: (error as Error).message,
      });
    }
  }

  async resolveIncident(incidentId: string): Promise<void> {
    try {
      const response = await fetch(`${this.apiUrl}/pages/${this.pageId}/incidents/${incidentId}`, {
        method: "PATCH",
        headers: {
          "Authorization": `OAuth ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          incident: {
            status: "resolved",
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Status page API error: ${response.status}`);
      }

      log.info("Incident resolved", { incidentId });
    } catch (error) {
      log.error("Failed to resolve incident", {
        incidentId,
        error: (error as Error).message,
      });
    }
  }

  // ─── Utility Methods ────────────────────────────────────────────────────

  getStatus(pageId?: string): Map<string, "operational" | "degraded_performance" | "partial_outage" | "major_outage"> {
    return this.componentStatuses;
  }

  getCheckStatus(checkId: string): "operational" | "degraded_performance" | "partial_outage" | "major_outage" | null {
    return this.componentStatuses.get(checkId) || null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

const log = createLogger("utils:synthetic-statuspage", process.env.LOG_LEVEL ?? "info");