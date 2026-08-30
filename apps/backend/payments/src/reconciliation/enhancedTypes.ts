/**
 * Issue #148 — Enhanced settlement reconciliation types.
 *
 * Extends the existing reconciliation types with fuzzy matching,
 * automated resolution rules, multi-currency support, settlement netting,
 * and SLA monitoring.
 */

// ─── Real-time Matching ───────────────────────────────────────────────────────

export interface SettlementMatch {
  internalRecordId: string;
  externalRecordId: string;
  matchScore: number; // 0-1
  matchType: "exact" | "fuzzy" | "netted" | "manual";
  discrepancies: Array<{
    field: string;
    internalValue: string;
    externalValue: string;
    severity: "minor" | "major" | "critical";
  }>;
}

export interface RealTimeMatcherConfig {
  /** Minimum score threshold for auto-matching (0-1). Default: 0.85 */
  autoMatchThreshold: number;
  /** Fields to compare for matching */
  matchFields: string[];
  /** Maximum time window for real-time matching in ms. Default: 1000 */
  matchWindowMs: number;
}

// ─── Reconciliation Rules ─────────────────────────────────────────────────────

export interface ReconciliationRule {
  id: string;
  name: string;
  condition: string; // expression evaluated against match context
  action: "auto_match" | "auto_resolve" | "flag_review" | "escalate";
  priority: number;
  config: Record<string, unknown>;
  enabled: boolean;
}

export interface RuleEvaluationContext {
  match: SettlementMatch;
  internalRecord: SettlementRecord;
  externalRecord: ExternalSettlementRecord;
  historicalDiscrepancies: number;
  timeSinceCreationMs: number;
}

// ─── Multi-Currency ───────────────────────────────────────────────────────────

export interface CurrencyRate {
  from: string;
  to: string;
  rate: number;
  timestamp: string;
}

export interface MultiCurrencySettlement {
  originalCurrency: string;
  originalAmount: string;
  convertedCurrency: string;
  convertedAmount: string;
  exchangeRate: number;
  rateTimestamp: string;
}

// ─── Settlement Netting ───────────────────────────────────────────────────────

export interface SettlementNet {
  currency: string;
  grossIncoming: string;
  grossOutgoing: string;
  netAmount: string;
  nettedTransactions: string[];
  settlementDate: string;
}

// ─── SLA Monitoring ───────────────────────────────────────────────────────────

export interface ReconciliationSLA {
  id: string;
  name: string;
  targetResolutionMs: number;
  warningThresholdPercent: number; // e.g. 80 = warn at 80% of target
  escalationThresholdPercent: number; // e.g. 100 = escalate at 100%
  enabled: boolean;
}

export interface SLAStatus {
  ruleId: string;
  slaId: string;
  discrepancyId: string;
  createdAt: string;
  deadlineAt: string;
  status: "on_track" | "warning" | "breached" | "resolved";
  resolutionTimeMs?: number;
}

// ─── Audit Trail ──────────────────────────────────────────────────────────────

export interface ReconciliationAuditEntry {
  id: string;
  discrepancyId: string;
  action: "detected" | "matched" | "resolved" | "escalated" | "manual_override";
  performedBy: string | "system";
  details: Record<string, unknown>;
  timestamp: string;
}

// ─── Core Records ─────────────────────────────────────────────────────────────

export interface SettlementRecord {
  id: string;
  orderId: string;
  escrowId: string;
  amount: string;
  currency: string;
  status: string;
  reference?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalSettlementRecord {
  id: string;
  reference?: string;
  amount: string;
  currency: string;
  status: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// ─── Enhanced Reconciliation Result ───────────────────────────────────────────

export interface EnhancedReconciliationResult {
  totalChecked: number;
  matchesFound: number;
  autoResolved: number;
  flaggedForReview: number;
  escalated: number;
  slaBreaches: number;
  netAmountByCurrency: Record<string, string>;
  durationMs: number;
  auditTrail: ReconciliationAuditEntry[];
}

// ─── Manual Override ──────────────────────────────────────────────────────────

export interface ManualOverrideRequest {
  discrepancyId: string;
  resolution: "match" | "dismiss" | "adjust";
  reason: string;
  performedBy: string;
  adjustmentAmount?: string;
  adjustmentCurrency?: string;
}
