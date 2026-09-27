/**
 * Timeout Refund Worker for Stalled Escrows (Issue #297)
 *
 * Scheduled worker that monitors escrows where `currentLedger >= timeoutLedger`
 * and their status is still "Funded" (not disputed or released). Submits a
 * Soroban `refund()` transaction on behalf of the buyer to recover stuck funds.
 *
 * Scope: apps/backend/payments/src/workers/timeoutRefund.ts
 */

import { createLogger } from "@delegolabs/utils";
import { Pool } from "pg";
import { escrowCoordinator } from "../escrowCoordinator/index.js";
import { getEscrowContractId } from "../../escrow/config.js";

const log = createLogger("payments:workers:timeoutRefund", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExpiredEscrowCheck {
  escrowId: string;
  orderId: string;
  buyerAddress: string;
  timeoutLedger: number;
  currentLedger: number;
}

export interface TimeoutRefundResult {
  escrowId: string;
  orderId: string;
  status: "refunded" | "skipped" | "failed";
  txHash?: string;
  reason?: string;
}

export interface TimeoutRefundSweepResult {
  checked: number;
  refunded: number;
  skipped: number;
  failed: number;
  results: TimeoutRefundResult[];
}

// ---------------------------------------------------------------------------
// Current ledger resolution
// ---------------------------------------------------------------------------

/**
 * Fetches the current ledger number from the Stellar Horizon API.
 * Falls back to SOROBAN_CURRENT_LEDGER_OVERRIDE env for testing.
 */
export async function getCurrentLedger(): Promise<number> {
  // Allow test/integration override
  const override = process.env.SOROBAN_CURRENT_LEDGER_OVERRIDE;
  if (override) {
    const n = parseInt(override, 10);
    if (!isNaN(n) && n > 0) return n;
  }

  const horizonUrl = process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
  try {
    const res = await fetch(`${horizonUrl}/ledgers?order=desc&limit=1`);
    if (!res.ok) {
      throw new Error(`Horizon returned ${res.status}`);
    }
    const body = await res.json() as {
      _embedded?: { records?: Array<{ sequence?: number }> };
    };
    const sequence = body._embedded?.records?.[0]?.sequence;
    if (typeof sequence === "number" && sequence > 0) {
      return sequence;
    }
    throw new Error("Unexpected Horizon response shape");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Failed to fetch current ledger from Horizon", { error: message });
    throw new Error(`Cannot determine current ledger: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Expired escrow discovery
// ---------------------------------------------------------------------------

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego",
    });
  }
  return pool;
}

export function _setPoolForTesting(testPool: Pool): void {
  pool = testPool;
}

export function _resetPoolForTesting(): void {
  pool = null;
}

/**
 * Queries the payment_records table for escrows that have:
 *   - status == 'funded'
 *   - NOT disputed or released
 *   - timeout_ledger <= currentLedger
 *
 * The `timeout_ledger` column is expected to be populated when the escrow
 * is funded (set from `FundEscrowParams.timeoutLedgers` + funding ledger).
 */
export async function findExpiredEscrows(currentLedger: number): Promise<ExpiredEscrowCheck[]> {
  const db = getPool();

  // Query payment_records for timed-out funded escrows.
  // We only trigger refunds for escrows that are:
  //   1. In "funded" status (not disputed, released, or refunded)
  //   2. Have a configured timeout_ledger that has passed
  const { rows } = await db.query<{
    escrow_id: string;
    order_id: string;
    buyer_address: string;
    timeout_ledger: number;
  }>(
    `SELECT escrow_id, order_id, buyer_address, timeout_ledger
     FROM payment_records
     WHERE status = 'funded'
       AND timeout_ledger IS NOT NULL
       AND timeout_ledger <= $1
     ORDER BY timeout_ledger ASC`,
    [currentLedger]
  );

  return rows.map((row) => ({
    escrowId: row.escrow_id,
    orderId: row.order_id,
    buyerAddress: row.buyer_address,
    timeoutLedger: row.timeout_ledger,
    currentLedger,
  }));
}

// ---------------------------------------------------------------------------
// Single escrow refund
// ---------------------------------------------------------------------------

/**
 * Checks whether an escrow is safe to refund (not disputed or released on-chain)
 * and submits the Soroban `refund()` transaction.
 *
 * Returns a `TimeoutRefundResult` describing the outcome.
 */
export async function processTimeoutRefund(
  check: ExpiredEscrowCheck,
  callerAddress: string,
  escrowContractId: string
): Promise<TimeoutRefundResult> {
  // Verify on-chain status before submitting — only refund if still "Funded"
  let onChainStatus: string;
  try {
    const status = await escrowCoordinator.getEscrowStatus(check.escrowId);
    onChainStatus = status.status;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("Could not fetch on-chain escrow status; skipping timeout refund", {
      escrowId: check.escrowId,
      error: message,
    });
    return {
      escrowId: check.escrowId,
      orderId: check.orderId,
      status: "skipped",
      reason: `Could not verify on-chain status: ${message}`,
    };
  }

  // Only trigger if escrow is not disputed or released
  if (onChainStatus === "disputed") {
    log.info("Skipping timeout refund — escrow is disputed", { escrowId: check.escrowId });
    return {
      escrowId: check.escrowId,
      orderId: check.orderId,
      status: "skipped",
      reason: "Escrow is disputed; timeout refund skipped",
    };
  }

  if (onChainStatus === "released" || onChainStatus === "refunded") {
    log.info("Skipping timeout refund — escrow already settled", {
      escrowId: check.escrowId,
      onChainStatus,
    });
    return {
      escrowId: check.escrowId,
      orderId: check.orderId,
      status: "skipped",
      reason: `Escrow already ${onChainStatus}; no refund needed`,
    };
  }

  // Submit the refund
  log.info("Submitting timeout refund for stalled escrow", {
    escrowId: check.escrowId,
    orderId: check.orderId,
    buyerAddress: check.buyerAddress,
    timeoutLedger: check.timeoutLedger,
    currentLedger: check.currentLedger,
  });

  try {
    const result = await escrowCoordinator.refundEscrow({
      escrowId: check.escrowId,
      escrowContractId,
      callerAddress,
      reason: "timeout",
    });

    if (result.status === "refunded") {
      log.info("Timeout refund successful", {
        escrowId: check.escrowId,
        txHash: result.txHash,
      });
      return {
        escrowId: check.escrowId,
        orderId: check.orderId,
        status: "refunded",
        txHash: result.txHash,
      };
    }

    return {
      escrowId: check.escrowId,
      orderId: check.orderId,
      status: "failed",
      reason: "Refund transaction did not succeed on-chain",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Timeout refund failed", {
      escrowId: check.escrowId,
      orderId: check.orderId,
      error: message,
    });
    return {
      escrowId: check.escrowId,
      orderId: check.orderId,
      status: "failed",
      reason: message,
    };
  }
}

// ---------------------------------------------------------------------------
// Main sweep
// ---------------------------------------------------------------------------

/**
 * Sweeps all timed-out funded escrows and submits Soroban refund() transactions.
 *
 * The `callerAddress` used to sign the refund is taken from
 * `ESCROW_AUTO_RELEASE_CALLER_ADDRESS` (shared with the auto-release feature)
 * or overridden via the `callerAddress` parameter.
 */
export async function runTimeoutRefundSweep(
  callerAddress?: string
): Promise<TimeoutRefundSweepResult> {
  const contractId = getEscrowContractId();
  const caller =
    callerAddress ??
    process.env.ESCROW_AUTO_RELEASE_CALLER_ADDRESS ??
    process.env.ESCROW_TIMEOUT_REFUND_CALLER_ADDRESS ??
    "";

  if (!caller) {
    const message =
      "ESCROW_AUTO_RELEASE_CALLER_ADDRESS or ESCROW_TIMEOUT_REFUND_CALLER_ADDRESS must be set for timeout refunds";
    log.error(message);
    throw new Error(message);
  }

  let currentLedger: number;
  try {
    currentLedger = await getCurrentLedger();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Timeout refund sweep aborted — cannot determine current ledger", { error: message });
    throw err;
  }

  log.info("Starting timeout refund sweep", { currentLedger, contractId, caller });

  const expired = await findExpiredEscrows(currentLedger);
  log.info("Found expired escrows", { count: expired.length, currentLedger });

  const results: TimeoutRefundResult[] = [];
  let refunded = 0;
  let skipped = 0;
  let failed = 0;

  for (const check of expired) {
    const result = await processTimeoutRefund(check, caller, contractId);
    results.push(result);

    if (result.status === "refunded") refunded += 1;
    else if (result.status === "skipped") skipped += 1;
    else failed += 1;
  }

  const sweepResult: TimeoutRefundSweepResult = {
    checked: expired.length,
    refunded,
    skipped,
    failed,
    results,
  };

  log.info("Timeout refund sweep complete", {
    checked: sweepResult.checked,
    refunded: sweepResult.refunded,
    skipped: sweepResult.skipped,
    failed: sweepResult.failed,
  });

  return sweepResult;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export interface TimeoutRefundSchedulerHandle {
  stop(): void;
}

/**
 * Starts a recurring timeout refund sweep on the configured interval.
 *
 * Interval defaults to 1 hour, configurable via:
 *   TIMEOUT_REFUND_INTERVAL_SECONDS (e.g. 3600)
 *
 * Set to "0" to disable (useful in worker-only deployments that run the
 * sweep on demand).
 */
export function startTimeoutRefundScheduler(
  callerAddress?: string
): TimeoutRefundSchedulerHandle {
  const intervalSeconds = parseInt(
    process.env.TIMEOUT_REFUND_INTERVAL_SECONDS ?? "3600",
    10
  );

  if (intervalSeconds <= 0) {
    log.info("Timeout refund scheduler disabled (TIMEOUT_REFUND_INTERVAL_SECONDS=0)");
    return { stop: () => {} };
  }

  log.info("Starting timeout refund scheduler", { intervalSeconds });

  // Run once immediately on startup, then on interval
  void runTimeoutRefundSweep(callerAddress).catch((err) => {
    log.error("Initial timeout refund sweep failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  const timer = setInterval(() => {
    void runTimeoutRefundSweep(callerAddress).catch((err) => {
      log.error("Timeout refund sweep failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalSeconds * 1_000);

  // Don't keep the process alive solely for this timer
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
      log.info("Timeout refund scheduler stopped");
    },
  };
}
