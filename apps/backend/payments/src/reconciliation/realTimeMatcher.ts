/**
 * Issue #148 — Real-time settlement matching with fuzzy comparison.
 *
 * Implements real-time transaction matching (<1s target) with:
 *  - Exact matching on references and amounts
 *  - Fuzzy matching for reference discrepancies
 *  - Configurable matching thresholds
 *  - Multi-field comparison with weighted scoring
 */

import { createLogger } from "@delegolabs/utils";
import type {
  SettlementMatch,
  SettlementRecord,
  ExternalSettlementRecord,
  RealTimeMatcherConfig,
} from "./enhancedTypes.js";

const log = createLogger("payments:realtime-matcher", process.env.LOG_LEVEL ?? "info");

// ─── Default Config ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG: RealTimeMatcherConfig = {
  autoMatchThreshold: 0.85,
  matchFields: ["reference", "amount", "currency", "orderId"],
  matchWindowMs: 1000,
};

// ─── Fuzzy String Comparison ──────────────────────────────────────────────────

/**
 * Levenshtein distance between two strings.
 * Used for fuzzy reference matching.
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

/**
 * Returns a similarity score between 0 and 1 for two strings.
 * 1 = identical, 0 = completely different.
 */
function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const maxLen = Math.max(a.length, b.length);
  const distance = levenshteinDistance(a.toLowerCase(), b.toLowerCase());
  return 1 - distance / maxLen;
}

// ─── Amount Comparison ────────────────────────────────────────────────────────

/**
 * Compares two monetary amounts with a tolerance for minor rounding differences.
 * Returns a score between 0 and 1.
 */
function amountSimilarity(a: string, b: string, tolerancePercent = 0.01): number {
  const numA = parseFloat(a);
  const numB = parseFloat(b);

  if (isNaN(numA) || isNaN(numB)) return 0;
  if (numA === numB) return 1;

  const diff = Math.abs(numA - numB);
  const avg = (Math.abs(numA) + Math.abs(numB)) / 2;
  if (avg === 0) return diff === 0 ? 1 : 0;

  const diffPercent = diff / avg;
  if (diffPercent <= tolerancePercent) return 1;
  // Linear decay for differences beyond tolerance
  return Math.max(0, 1 - diffPercent);
}

// ─── Core Matching ────────────────────────────────────────────────────────────

export interface FieldMatchResult {
  field: string;
  internalValue: string;
  externalValue: string;
  score: number;
  severity: "minor" | "major" | "critical";
}

function classifySeverity(field: string, score: number): "minor" | "major" | "critical" {
  if (score === 1) return "minor"; // Perfect match — no real discrepancy
  if (field === "amount" || field === "currency") {
    return score >= 0.99 ? "minor" : score >= 0.95 ? "major" : "critical";
  }
  // Reference/orderId fields
  return score >= 0.8 ? "minor" : score >= 0.5 ? "major" : "critical";
}

function compareFields(
  internal: SettlementRecord,
  external: ExternalSettlementRecord,
  config: RealTimeMatcherConfig
): FieldMatchResult[] {
  const results: FieldMatchResult[] = [];

  for (const field of config.matchFields) {
    const internalVal = getFieldValue(internal, field);
    const externalVal = getFieldValue(external, field);

    if (internalVal === undefined || externalVal === undefined) continue;

    let score: number;
    if (field === "amount") {
      score = amountSimilarity(internalVal, externalVal);
    } else if (field === "reference" || field === "orderId") {
      score = stringSimilarity(internalVal, externalVal);
    } else {
      score = internalVal === externalVal ? 1 : 0;
    }

    results.push({
      field,
      internalValue: internalVal,
      externalValue: externalVal,
      score,
      severity: classifySeverity(field, score),
    });
  }

  return results;
}

function getFieldValue(
  record: SettlementRecord | ExternalSettlementRecord,
  field: string
): string | undefined {
  switch (field) {
    case "reference":
      return record.reference;
    case "amount":
      return record.amount;
    case "currency":
      return record.currency;
    case "orderId":
      return "orderId" in record ? record.orderId : undefined;
    default:
      return undefined;
  }
}

function calculateOverallScore(fieldResults: FieldMatchResult[]): number {
  if (fieldResults.length === 0) return 0;

  // Weighted average: amount and currency are more important
  const weights: Record<string, number> = {
    amount: 3,
    currency: 2,
    reference: 2,
    orderId: 1,
  };

  let totalWeight = 0;
  let weightedScore = 0;

  for (const result of fieldResults) {
    const weight = weights[result.field] ?? 1;
    weightedScore += result.score * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? weightedScore / totalWeight : 0;
}

/**
 * Matches an internal settlement record against an external record.
 * Returns a SettlementMatch with score, type, and discrepancy details.
 */
export function matchRecords(
  internal: SettlementRecord,
  external: ExternalSettlementRecord,
  config: Partial<RealTimeMatcherConfig> = {}
): SettlementMatch {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const fieldResults = compareFields(internal, external, fullConfig);
  const overallScore = calculateOverallScore(fieldResults);

  const discrepancies = fieldResults
    .filter((r) => r.score < 1)
    .map((r) => ({
      field: r.field,
      internalValue: r.internalValue,
      externalValue: r.externalValue,
      severity: r.severity,
    }));

  let matchType: SettlementMatch["matchType"];
  if (overallScore === 1) {
    matchType = "exact";
  } else if (overallScore >= fullConfig.autoMatchThreshold) {
    matchType = "fuzzy";
  } else {
    // Still return the match — it will be flagged for review
    matchType = "fuzzy";
  }

  return {
    internalRecordId: internal.id,
    externalRecordId: external.id,
    matchScore: overallScore,
    matchType,
    discrepancies,
  };
}

/**
 * Performs real-time batch matching: finds the best external match
 * for each internal record within the time window.
 */
export function matchBatch(
  internalRecords: SettlementRecord[],
  externalRecords: ExternalSettlementRecord[],
  config: Partial<RealTimeMatcherConfig> = {}
): SettlementMatch[] {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const start = Date.now();
  const matches: SettlementMatch[] = [];

  const matchedExternal = new Set<string>();

  for (const internal of internalRecords) {
    let bestMatch: SettlementMatch | null = null;

    for (const external of externalRecords) {
      if (matchedExternal.has(external.id)) continue;

      const match = matchRecords(internal, external, fullConfig);

      if (!bestMatch || match.matchScore > bestMatch.matchScore) {
        bestMatch = match;
      }
    }

    if (bestMatch && bestMatch.matchScore > 0) {
      matches.push(bestMatch);
      matchedExternal.add(bestMatch.externalRecordId);
    }

    // Enforce time window
    if (Date.now() - start > fullConfig.matchWindowMs) {
      log.warn("Real-time matching exceeded time window", {
        processed: matches.length,
        remaining: internalRecords.length - matches.length,
        elapsedMs: Date.now() - start,
      });
      break;
    }
  }

  log.info("Real-time batch matching completed", {
    totalInternal: internalRecords.length,
    totalExternal: externalRecords.length,
    matchesFound: matches.length,
    durationMs: Date.now() - start,
  });

  return matches;
}
