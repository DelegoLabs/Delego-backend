/**
 * Issue #148 — Enhanced settlement reconciler.
 *
 * Orchestrates real-time matching, automated resolution rules,
 * SLA monitoring, and audit trail generation.
 */

import { createLogger } from "@delegolabs/utils";
import { Pool } from "pg";
import { matchBatch, type FieldMatchResult } from "./realTimeMatcher.js";
import { evaluateRules, DEFAULT_RULES, type RuleAction } from "./reconciliationRules.js";
import { SLATracker, DEFAULT_SLAS } from "./slaMonitor.js";
import type {
  SettlementRecord,
  ExternalSettlementRecord,
  SettlementMatch,
  EnhancedReconciliationResult,
  ReconciliationAuditEntry,
  ReconciliationRule,
  ManualOverrideRequest,
} from "./enhancedTypes.js";

const log = createLogger("payments:enhanced-reconciler", process.env.LOG_LEVEL ?? "info");

// ─── Types ────────────────────────────────────────────────────────────────────

interface EnhancedReconcilerConfig {
  rules: ReconciliationRule[];
  autoMatchThreshold: number;
  matchWindowMs: number;
}

const DEFAULT_CONFIG: EnhancedReconcilerConfig = {
  rules: DEFAULT_RULES,
  autoMatchThreshold: 0.85,
  matchWindowMs: 1000,
};

// ─── Enhanced Reconciler ──────────────────────────────────────────────────────

export class EnhancedSettlementReconciler {
  private slaTracker: SLATracker;
  private auditTrail: ReconciliationAuditEntry[] = [];
  private manualOverrides = new Map<string, ManualOverrideRequest>();

  constructor(
    private readonly pool: Pool,
    private readonly config: EnhancedReconcilerConfig = DEFAULT_CONFIG
  ) {
    this.slaTracker = new SLATracker(DEFAULT_SLAS);
  }

  /**
   * Runs a full enhanced reconciliation cycle with real-time matching.
   */
  async reconcile(): Promise<EnhancedReconciliationResult> {
    const start = Date.now();
    log.info("Starting enhanced reconciliation cycle");

    // 1. Fetch internal and external records
    const internalRecords = await this.fetchInternalRecords();
    const externalRecords = await this.fetchExternalRecords();

    // 2. Perform real-time matching
    const matches = matchBatch(internalRecords, externalRecords, {
      autoMatchThreshold: this.config.autoMatchThreshold,
      matchWindowMs: this.config.matchWindowMs,
    });

    // 3. Evaluate rules for each match
    let autoResolved = 0;
    let flaggedForReview = 0;
    let escalated = 0;
    let slaBreaches = 0;

    for (const match of matches) {
      const internal = internalRecords.find((r) => r.id === match.internalRecordId);
      const external = externalRecords.find((r) => r.id === match.externalRecordId);
      if (!internal || !external) continue;

      // Check for manual override
      const overrideKey = `${match.internalRecordId}-${match.externalRecordId}`;
      if (this.manualOverrides.has(overrideKey)) {
        continue;
      }

      const ruleResult = evaluateRules(
        match,
        internal,
        external,
        this.config.rules
      );

      this.auditTrail.push(ruleResult.auditEntry);

      // Start SLA tracking for flagged/escalated items
      if (ruleResult.action === "flag_review" || ruleResult.action === "escalate") {
        const hasCritical = match.discrepancies.some((d) => d.severity === "critical");
        const amount = parseFloat(internal.amount);
        this.slaTracker.startTracking(
          ruleResult.auditEntry.discrepancyId,
          hasCritical,
          amount
        );
      }

      switch (ruleResult.action) {
        case "auto_match":
        case "auto_resolve":
          autoResolved++;
          // Auto-resolve: update internal record status
          await this.autoResolve(match, internal, external);
          break;
        case "flag_review":
          flaggedForReview++;
          break;
        case "escalate":
          escalated++;
          break;
      }
    }

    // 4. Check SLA compliance
    const slaUpdates = this.slaTracker.checkActiveSLAs();
    for (const update of slaUpdates) {
      if (update.status === "breached") {
        slaBreaches++;
        this.auditTrail.push({
          id: `sla-breach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          discrepancyId: update.discrepancyId,
          action: "escalated",
          performedBy: "sla-monitor",
          details: {
            slaId: update.slaId,
            breachAt: new Date().toISOString(),
          },
          timestamp: new Date().toISOString(),
        });
      }
    }

    // 5. Compute net amounts by currency
    const netAmountByCurrency = this.computeNetAmounts(internalRecords, externalRecords, matches);

    const result: EnhancedReconciliationResult = {
      totalChecked: internalRecords.length,
      matchesFound: matches.length,
      autoResolved,
      flaggedForReview,
      escalated,
      slaBreaches,
      netAmountByCurrency,
      durationMs: Date.now() - start,
      auditTrail: [...this.auditTrail],
    };

    log.info("Enhanced reconciliation cycle completed", {
      totalChecked: result.totalChecked,
      matchesFound: result.matchesFound,
      autoResolved: result.autoResolved,
      flaggedForReview: result.flaggedForReview,
      escalated: result.escalated,
      slaBreaches: result.slaBreaches,
      durationMs: result.durationMs,
    });

    return result;
  }

  /**
   * Applies a manual override to a discrepancy.
   */
  async applyManualOverride(request: ManualOverrideRequest): Promise<void> {
    this.manualOverrides.set(request.discrepancyId, request);

    this.auditTrail.push({
      id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      discrepancyId: request.discrepancyId,
      action: "manual_override",
      performedBy: request.performedBy,
      details: {
        resolution: request.resolution,
        reason: request.reason,
        adjustmentAmount: request.adjustmentAmount,
      },
      timestamp: new Date().toISOString(),
    });

    // Resolve SLA if tracking
    this.slaTracker.resolve(request.discrepancyId);

    log.info("Manual override applied", {
      discrepancyId: request.discrepancyId,
      resolution: request.resolution,
      performedBy: request.performedBy,
    });
  }

  /**
   * Gets current SLA compliance statistics.
   */
  getSLACompliance() {
    return this.slaTracker.getComplianceStats();
  }

  /**
   * Gets all active SLA tracking entries.
   */
  getActiveSLAs() {
    return this.slaTracker.getActiveSLAs();
  }

  /**
   * Gets the full audit trail.
   */
  getAuditTrail(): ReconciliationAuditEntry[] {
    return [...this.auditTrail];
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async autoResolve(
    match: SettlementMatch,
    internal: SettlementRecord,
    external: ExternalSettlementRecord
  ): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE payment_records
         SET status = $1, updated_at = NOW()
         WHERE id = $2`,
        [this.mapExternalStatus(external.status), internal.id]
      );

      log.info("Auto-resolved discrepancy", {
        internalId: internal.id,
        externalId: external.id,
        matchScore: match.matchScore,
        newStatus: external.status,
      });
    } catch (err) {
      log.error("Failed to auto-resolve discrepancy", {
        internalId: internal.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async fetchInternalRecords(): Promise<SettlementRecord[]> {
    try {
      const { rows } = await this.pool.query<{
        id: string;
        order_id: string;
        escrow_id: string;
        amount: string;
        currency: string;
        status: string;
        reference: string | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT id, order_id, escrow_id, amount, currency, status, reference, created_at, updated_at
         FROM payment_records
         WHERE status NOT IN ('released', 'refunded')
         AND escrow_id IS NOT NULL
         ORDER BY updated_at ASC`
      );

      return rows.map((row) => ({
        id: row.id,
        orderId: row.order_id,
        escrowId: row.escrow_id,
        amount: row.amount,
        currency: row.currency ?? "XLM",
        status: row.status,
        reference: row.reference ?? undefined,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }));
    } catch (err) {
      log.error("Failed to fetch internal records", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private async fetchExternalRecords(): Promise<ExternalSettlementRecord[]> {
    // In production, this would call an external settlement API or
    // read from an external data source. For now, return an empty array
    // as the external source integration is environment-specific.
    return [];
  }

  private mapExternalStatus(externalStatus: string): string {
    const statusMap: Record<string, string> = {
      completed: "released",
      settled: "released",
      pending: "funded",
      processing: "funded",
      failed: "failed",
      cancelled: "refunded",
      refunded: "refunded",
    };
    return statusMap[externalStatus] ?? externalStatus;
  }

  private computeNetAmounts(
    internalRecords: SettlementRecord[],
    _externalRecords: ExternalSettlementRecord[],
    matches: SettlementMatch[]
  ): Record<string, string> {
    const nets: Record<string, bigint> = {};

    for (const match of matches) {
      const internal = internalRecords.find((r) => r.id === match.internalRecordId);
      if (!internal) continue;

      const currency = internal.currency ?? "XLM";
      const amount = BigInt(internal.amount);
      nets[currency] = (nets[currency] ?? 0n) + amount;
    }

    const result: Record<string, string> = {};
    for (const [currency, amount] of Object.entries(nets)) {
      result[currency] = amount.toString();
    }
    return result;
  }
}
