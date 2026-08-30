/**
 * Issue #148 — Reconciliation SLA monitoring.
 *
 * Tracks reconciliation SLA compliance and triggers alerts
 * when resolution times approach or breach targets.
 */

import { createLogger } from "@delegolabs/utils";
import type {
  ReconciliationSLA,
  SLAStatus,
} from "./enhancedTypes.js";

const log = createLogger("payments:reconciliation-sla", process.env.LOG_LEVEL ?? "info");

// ─── Default SLAs ─────────────────────────────────────────────────────────────

export const DEFAULT_SLAS: ReconciliationSLA[] = [
  {
    id: "standard_reconciliation",
    name: "Standard reconciliation SLA",
    targetResolutionMs: 300_000, // 5 minutes
    warningThresholdPercent: 80,
    escalationThresholdPercent: 100,
    enabled: true,
  },
  {
    id: "critical_discrepancy",
    name: "Critical discrepancy SLA",
    targetResolutionMs: 60_000, // 1 minute
    warningThresholdPercent: 70,
    escalationThresholdPercent: 100,
    enabled: true,
  },
  {
    id: "large_amount",
    name: "Large amount reconciliation SLA",
    targetResolutionMs: 120_000, // 2 minutes
    warningThresholdPercent: 80,
    escalationThresholdPercent: 100,
    enabled: true,
  },
];

// ─── SLA Tracker ──────────────────────────────────────────────────────────────

export class SLATracker {
  private activeSLAs = new Map<string, SLAStatus>();
  private completedSLAs: SLAStatus[] = [];

  constructor(private readonly slas: ReconciliationSLA[] = DEFAULT_SLAS) {}

  /**
   * Starts tracking SLA for a new discrepancy.
   */
  startTracking(
    discrepancyId: string,
    hasCriticalDiscrepancy: boolean,
    amount?: number
  ): SLAStatus {
    // Select appropriate SLA
    const sla = this.selectSLA(hasCriticalDiscrepancy, amount);

    const now = new Date();
    const deadline = new Date(now.getTime() + sla.targetResolutionMs);

    const status: SLAStatus = {
      ruleId: sla.id,
      slaId: sla.id,
      discrepancyId,
      createdAt: now.toISOString(),
      deadlineAt: deadline.toISOString(),
      status: "on_track",
    };

    this.activeSLAs.set(discrepancyId, status);

    log.debug("SLA tracking started", {
      discrepancyId,
      slaId: sla.id,
      deadlineAt: status.deadlineAt,
    });

    return status;
  }

  /**
   * Checks and updates all active SLA statuses.
   * Returns any SLAs that have entered warning or breach state.
   */
  checkActiveSLAs(): SLAStatus[] {
    const now = Date.now();
    const updated: SLAStatus[] = [];

    for (const [discrepancyId, status] of this.activeSLAs) {
      const sla = this.slas.find((s) => s.id === status.slaId);
      if (!sla) continue;

      const created = new Date(status.createdAt).getTime();
      const targetMs = sla.targetResolutionMs;
      const elapsed = now - created;
      const elapsedPercent = (elapsed / targetMs) * 100;

      let newStatus: SLAStatus["status"] = "on_track";

      if (elapsed >= targetMs) {
        newStatus = "breached";
      } else if (elapsedPercent >= sla.escalationThresholdPercent) {
        newStatus = "breached";
      } else if (elapsedPercent >= sla.warningThresholdPercent) {
        newStatus = "warning";
      }

      if (newStatus !== status.status) {
        status.status = newStatus;
        updated.push({ ...status });

        if (newStatus === "warning") {
          log.warn("SLA warning threshold reached", {
            discrepancyId,
            slaId: sla.id,
            elapsedPercent: Math.round(elapsedPercent),
          });
        } else if (newStatus === "breached") {
          log.error("SLA breached", {
            discrepancyId,
            slaId: sla.id,
            elapsedMs: elapsed,
            targetMs,
          });
        }
      }
    }

    return updated;
  }

  /**
   * Resolves an SLA tracking entry.
   */
  resolve(discrepancyId: string): SLAStatus | null {
    const status = this.activeSLAs.get(discrepancyId);
    if (!status) return null;

    status.status = "resolved";
    status.resolutionTimeMs =
      Date.now() - new Date(status.createdAt).getTime();

    this.completedSLAs.push({ ...status });
    this.activeSLAs.delete(discrepancyId);

    log.info("SLA resolved", {
      discrepancyId,
      resolutionTimeMs: status.resolutionTimeMs,
      slaId: status.slaId,
    });

    return status;
  }

  /**
   * Gets all active SLA statuses.
   */
  getActiveSLAs(): SLAStatus[] {
    return Array.from(this.activeSLAs.values());
  }

  /**
   * Gets SLA compliance statistics.
   */
  getComplianceStats(): {
    total: number;
    resolved: number;
    breached: number;
    onTrack: number;
    avgResolutionMs: number;
    complianceRate: number;
  } {
    const total = this.completedSLAs.length;
    const resolved = this.completedSLAs.filter((s) => s.status === "resolved").length;
    const breached = this.completedSLAs.filter((s) => s.status === "breached").length;
    const onTrack = this.activeSLAs.size;

    const resolvedWithTime = this.completedSLAs.filter(
      (s) => s.status === "resolved" && s.resolutionTimeMs !== undefined
    );
    const avgResolutionMs =
      resolvedWithTime.length > 0
        ? resolvedWithTime.reduce((sum, s) => sum + (s.resolutionTimeMs ?? 0), 0) /
          resolvedWithTime.length
        : 0;

    const complianceRate = total > 0 ? ((total - breached) / total) * 100 : 100;

    return {
      total,
      resolved,
      breached,
      onTrack,
      avgResolutionMs,
      complianceRate,
    };
  }

  private selectSLA(
    hasCriticalDiscrepancy: boolean,
    amount?: number
  ): ReconciliationSLA {
    if (hasCriticalDiscrepancy) {
      const criticalSLA = this.slas.find((s) => s.id === "critical_discrepancy");
      if (criticalSLA) return criticalSLA;
    }

    if (amount !== undefined && amount > 1_000_000_000) {
      const largeSLA = this.slas.find((s) => s.id === "large_amount");
      if (largeSLA) return largeSLA;
    }

    return this.slas.find((s) => s.id === "standard_reconciliation") ?? this.slas[0];
  }
}
