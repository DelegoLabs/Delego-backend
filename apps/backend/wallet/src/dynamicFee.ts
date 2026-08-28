import { estimateTransactionFee, type FeeEstimate } from "@delegolabs/payments";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("wallet:dynamic-fee", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeePriority = "economic" | "normal" | "fast";

export interface DynamicFeeEstimate {
  /** The resolved fee in stroops to use in the transaction. */
  feeStroops: string;
  /** Priority level used for this estimate. */
  priority: FeePriority;
  /** Raw estimate from the fee estimator. */
  estimate: FeeEstimate;
  /** Timestamp of the estimate. */
  fetchedAt: string;
}

/** Map priority levels to percentiles. */
const PRIORITY_TO_PERCENTILE: Record<FeePriority, "p50" | "p95" | "p99"> = {
  economic: "p50",
  normal: "p95",
  fast: "p99",
};

/** Base fee override: when Horizon is unreachable, use this as fallback. */
const DEFAULT_FEE_STROOPS = "100";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a dynamic fee estimate for a Stellar transaction based on the desired
 * priority level.
 *
 * @param horizonUrl - The Horizon server URL.
 * @param priority - "economic" (p50), "normal" (p95), or "fast" (p99).
 * @returns DynamicFeeEstimate with the fee to use in the transaction builder.
 */
export async function getDynamicFee(
  horizonUrl: string,
  priority: FeePriority = "normal"
): Promise<DynamicFeeEstimate> {
  const percentile = PRIORITY_TO_PERCENTILE[priority];
  const estimate = await estimateTransactionFee(horizonUrl, percentile);

  const feeStroops = String(estimate.recommendedFeeStroops);

  log.info("Dynamic fee estimated", {
    priority,
    feeStroops,
    source: estimate.source,
  });

  return {
    feeStroops,
    priority,
    estimate,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Get the fee to use in a TransactionBuilder, falling back to the default
 * base fee if estimation fails.
 */
export async function getTransactionFee(
  horizonUrl: string,
  priority: FeePriority = "normal"
): Promise<string> {
  try {
    const result = await getDynamicFee(horizonUrl, priority);
    return result.feeStroops;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("Failed to estimate dynamic fee, using default", { error: message });
    return DEFAULT_FEE_STROOPS;
  }
}

/**
 * Calculate fee savings between individual and batched transactions.
 */
export function calculateBatchFeeSavings(
  operationCount: number,
  currentFeePerTx: number
): {
  individualTotal: number;
  batchedTotal: number;
  savings: number;
  savingsPercent: number;
} {
  const individualTotal = operationCount * currentFeePerTx;
  // Stellar batched: base fee + 10 stroops per additional operation
  const batchedTotal = 100 + (operationCount - 1) * 10;
  const savings = individualTotal - batchedTotal;
  const savingsPercent = individualTotal > 0 ? (savings / individualTotal) * 100 : 0;

  return { individualTotal, batchedTotal, savings, savingsPercent };
}

/**
 * Estimate fee for a Soroban contract invocation.
 * Soroban transactions require a resource fee from simulation in addition
 * to the base network fee.
 */
export async function getSorobanFee(
  horizonUrl: string,
  simulatedMinResourceFee: string,
  priority: FeePriority = "normal"
): Promise<string> {
  const baseFee = await getTransactionFee(horizonUrl, priority);
  const resourceFee = parseInt(simulatedMinResourceFee, 10);
  const baseFeeNum = parseInt(baseFee, 10);

  // The total fee is the resource fee (from simulation) plus the base network fee
  const totalFee = Math.max(resourceFee + baseFeeNum, baseFeeNum);

  return String(totalFee);
}
