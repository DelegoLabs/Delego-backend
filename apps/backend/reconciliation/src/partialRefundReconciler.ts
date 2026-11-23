/**
 * Partial Refund Settlement Reconciliation Engine
 *
 * Issue #624 — When a merchant and buyer agree to a partial refund, this
 * engine verifies that the Soroban contract split matches the database
 * settlement records, flags any rounding leakage or mismatch, and records
 * the resolution in the order timeline / accounting ledger.
 *
 * All monetary comparisons are performed in stroops (bigint) to avoid
 * floating-point rounding errors inherent to fractional XLM arithmetic.
 */

import { sequelize } from "./db.js";
import { AuditLog } from "./models/AuditLog.js";
import {
  rpc,
  Horizon,
  Operation,
  TransactionBuilder,
  Networks,
  scValToNative,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { createLogger } from "@delegolabs/utils";
import type {
  PartialRefundReconciliation,
  PartialRefundReconciliationResult,
} from "./schemas.js";

const log = createLogger("reconciliation:partial-refund", process.env.LOG_LEVEL ?? "info");

// ── Stellar network helpers ──────────────────────────────────────────────────

function getStellarConfig() {
  const network = (process.env.STELLAR_NETWORK ?? "testnet").toLowerCase();
  if (network === "mainnet") {
    return {
      horizonUrl: process.env.STELLAR_HORIZON_URL ?? "https://horizon.stellar.org",
      rpcUrl: process.env.STELLAR_RPC_URL ?? "https://mainnet.sorobanrpc.com",
      networkPassphrase: Networks.PUBLIC,
    };
  }
  if (network === "futurenet") {
    return {
      horizonUrl:
        process.env.STELLAR_HORIZON_URL ?? "https://horizon-futurenet.stellar.org",
      rpcUrl: process.env.STELLAR_RPC_URL ?? "https://rpc-futurenet.stellar.org",
      networkPassphrase: Networks.FUTURENET,
    };
  }
  return {
    horizonUrl:
      process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org",
    rpcUrl: process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
  };
}

// ── DB row shape returned by the settlement query ───────────────────────────

interface PartialRefundRow {
  order_id: string;
  escrow_contract_id: string;
  buyer_address: string;
  total_order_stroops: string;
  buyer_refund_stroops: string;
  merchant_disbursement_stroops: string;
}

// ── On-chain query ───────────────────────────────────────────────────────────

/**
 * Calls the Soroban contract `get_partial_refund` function and returns the
 * on-chain disbursement amounts for buyer and merchant.
 *
 * The contract is expected to return a map/struct with at least:
 *   { buyer_amount: i128, merchant_amount: i128 }
 *
 * Returns `null` when the contract cannot be reached or the simulation fails
 * (the caller treats this as an unresolvable discrepancy and flags it).
 */
async function queryOnChainPartialRefund(
  escrowContractId: string,
  orderId: string,
  buyerAddress: string,
  horizonUrl: string,
  rpcUrl: string,
  networkPassphrase: string,
): Promise<{ buyerStroops: bigint; merchantStroops: bigint } | null> {
  const sourceAddress =
    process.env.ESCROW_READ_SOURCE_ADDRESS ??
    process.env.SETTLEMENT_SOURCE_ADDRESS ??
    buyerAddress;

  if (!sourceAddress) {
    log.warn(`No source address available for order ${orderId}`);
    return null;
  }

  try {
    const horizon = new Horizon.Server(horizonUrl);
    const rpcServer = new rpc.Server(rpcUrl);

    const account = await horizon.loadAccount(sourceAddress);

    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: escrowContractId,
          function: "get_partial_refund",
          args: [nativeToScVal(orderId, { type: "string" })],
        }),
      )
      .setTimeout(30)
      .build();

    const sim = await rpcServer.simulateTransaction(tx);

    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
      log.warn(`Simulation failed for order ${orderId}`, {
        contractId: escrowContractId,
      });
      return null;
    }

    const native = scValToNative(sim.result.retval) as Record<string, unknown>;

    // The contract returns amounts in stroops as i128 (JS bigint via SDK).
    const buyerStroops = BigInt(native["buyer_amount"] as string | number | bigint);
    const merchantStroops = BigInt(
      native["merchant_amount"] as string | number | bigint,
    );

    return { buyerStroops, merchantStroops };
  } catch (err) {
    log.warn(`Error querying on-chain partial refund for order ${orderId}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Accounting ledger helpers ────────────────────────────────────────────────

/**
 * Writes two ledger entries — one for the buyer refund and one for the
 * merchant disbursement — into the `accounting_ledger` table.
 *
 * Uses raw SQL consistent with the rest of the reconciliation service rather
 * than introducing a new Sequelize model.
 */
async function upsertLedgerEntries(
  orderId: string,
  buyerRefundStroops: bigint,
  merchantDisbursementStroops: bigint,
  contractDisbursedBuyer: bigint,
  contractDisbursedMerchant: bigint,
  isBalanced: boolean,
): Promise<void> {
  await sequelize.query(
    `
    INSERT INTO accounting_ledger
      (order_id, entry_type, db_amount_stroops, on_chain_amount_stroops, is_balanced, recorded_at)
    VALUES
      (:orderId, 'partial_refund_buyer',    :dbBuyer,    :onChainBuyer,    :isBalanced, NOW()),
      (:orderId, 'partial_refund_merchant', :dbMerchant, :onChainMerchant, :isBalanced, NOW())
    ON CONFLICT (order_id, entry_type)
    DO UPDATE SET
      db_amount_stroops     = EXCLUDED.db_amount_stroops,
      on_chain_amount_stroops = EXCLUDED.on_chain_amount_stroops,
      is_balanced           = EXCLUDED.is_balanced,
      recorded_at           = EXCLUDED.recorded_at
    `,
    {
      replacements: {
        orderId,
        dbBuyer: buyerRefundStroops.toString(),
        onChainBuyer: contractDisbursedBuyer.toString(),
        dbMerchant: merchantDisbursementStroops.toString(),
        onChainMerchant: contractDisbursedMerchant.toString(),
        isBalanced,
      },
    },
  );
}

/**
 * Appends an event to the `order_timeline` table so the partial-refund
 * resolution is visible in the order's history.
 */
async function recordOrderTimelineEvent(
  orderId: string,
  result: PartialRefundReconciliationResult,
): Promise<void> {
  const { record, roundingLeakage, buyerMatch, merchantMatch } = result;

  await sequelize.query(
    `
    INSERT INTO order_timeline
      (order_id, event_type, payload, occurred_at)
    VALUES
      (:orderId, 'partial_refund_reconciled', :payload::jsonb, NOW())
    `,
    {
      replacements: {
        orderId,
        payload: JSON.stringify({
          totalOrderStroops: record.totalOrderStroops.toString(),
          buyerRefundStroops: record.buyerRefundStroops.toString(),
          merchantDisbursementStroops: record.merchantDisbursementStroops.toString(),
          contractDisbursedBuyer: record.contractDisbursedBuyer.toString(),
          contractDisbursedMerchant: record.contractDisbursedMerchant.toString(),
          isBalanced: record.isBalanced,
          roundingLeakage: roundingLeakage.toString(),
          buyerMatch,
          merchantMatch,
        }),
      },
    },
  );
}

// ── Core reconciler ──────────────────────────────────────────────────────────

export class PartialRefundReconciler {
  /**
   * Reconcile all pending partial-refund settlements.
   *
   * Queries the database for orders in `partial_refund_pending` status,
   * checks the on-chain Soroban contract for each one, and:
   *   1. Builds a `PartialRefundReconciliation` snapshot.
   *   2. Detects rounding leakage and per-side mismatches.
   *   3. Updates the accounting ledger.
   *   4. Records the event in the order timeline.
   *   5. Logs and returns any flagged discrepancies.
   *
   * @param orderIds - Optional list of specific order IDs to reconcile.
   *                   When omitted all `partial_refund_pending` orders are processed.
   */
  async reconcile(orderIds?: string[]): Promise<{
    processed: number;
    balanced: number;
    discrepancies: PartialRefundReconciliationResult[];
  }> {
    const { horizonUrl, rpcUrl, networkPassphrase } = getStellarConfig();

    // ── 1. Fetch pending partial-refund orders from the DB ─────────────────
    let query = `
      SELECT
        pr.order_id,
        pr.escrow_contract_id,
        pr.buyer_address,
        pr.total_order_stroops,
        pr.buyer_refund_stroops,
        pr.merchant_disbursement_stroops
      FROM partial_refund_settlements pr
      WHERE pr.status = 'partial_refund_pending'
    `;

    const replacements: Record<string, unknown> = {};

    if (orderIds && orderIds.length > 0) {
      query += ` AND pr.order_id IN (:orderIds)`;
      replacements["orderIds"] = orderIds;
    }

    const [rows] = await sequelize.query(query, { replacements });
    const records = rows as PartialRefundRow[];

    log.info(`Reconciling ${records.length} partial-refund settlement(s)`);

    const discrepancies: PartialRefundReconciliationResult[] = [];
    let balanced = 0;

    // ── 2. Process each order ──────────────────────────────────────────────
    for (const row of records) {
      const orderId = row.order_id;

      const totalOrderStroops = BigInt(row.total_order_stroops);
      const buyerRefundStroops = BigInt(row.buyer_refund_stroops);
      const merchantDisbursementStroops = BigInt(row.merchant_disbursement_stroops);

      // ── 3. Query on-chain ──────────────────────────────────────────────
      const onChain = await queryOnChainPartialRefund(
        row.escrow_contract_id,
        orderId,
        row.buyer_address,
        horizonUrl,
        rpcUrl,
        networkPassphrase,
      );

      const contractDisbursedBuyer = onChain?.buyerStroops ?? 0n;
      const contractDisbursedMerchant = onChain?.merchantStroops ?? 0n;

      // ── 4. Balance check: buyer + merchant == original escrow ──────────
      const onChainTotal = contractDisbursedBuyer + contractDisbursedMerchant;
      const isBalanced = onChainTotal === totalOrderStroops;

      // ── 5. Per-side match checks ───────────────────────────────────────
      const buyerMatch = contractDisbursedBuyer === buyerRefundStroops;
      const merchantMatch = contractDisbursedMerchant === merchantDisbursementStroops;

      // Rounding leakage = what the DB expects minus what landed on-chain.
      // Positive → funds went missing; negative → excess disbursed.
      const roundingLeakage = totalOrderStroops - onChainTotal;

      const reconciliation: PartialRefundReconciliation = {
        orderId,
        totalOrderStroops,
        buyerRefundStroops,
        merchantDisbursementStroops,
        contractDisbursedBuyer,
        contractDisbursedMerchant,
        isBalanced,
      };

      const result: PartialRefundReconciliationResult = {
        orderId,
        record: reconciliation,
        roundingLeakage,
        buyerMatch,
        merchantMatch,
      };

      // ── 6. Update accounting ledger ────────────────────────────────────
      try {
        await upsertLedgerEntries(
          orderId,
          buyerRefundStroops,
          merchantDisbursementStroops,
          contractDisbursedBuyer,
          contractDisbursedMerchant,
          isBalanced,
        );
      } catch (err) {
        log.error(`Failed to update accounting ledger for order ${orderId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue — a ledger write failure must not suppress the discrepancy flag.
      }

      // ── 7. Record order timeline event ────────────────────────────────
      try {
        await recordOrderTimelineEvent(orderId, result);
      } catch (err) {
        log.error(`Failed to record timeline event for order ${orderId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // ── 8. Emit audit log and collect discrepancies ────────────────────
      if (!isBalanced || !buyerMatch || !merchantMatch) {
        log.warn(`Partial refund discrepancy detected for order ${orderId}`, {
          totalOrderStroops: totalOrderStroops.toString(),
          onChainTotal: onChainTotal.toString(),
          roundingLeakage: roundingLeakage.toString(),
          buyerMatch,
          merchantMatch,
          contractDisbursedBuyer: contractDisbursedBuyer.toString(),
          contractDisbursedMerchant: contractDisbursedMerchant.toString(),
        });

        discrepancies.push(result);

        await AuditLog.create({
          action: "partial_refund_discrepancy",
          details: {
            orderId,
            totalOrderStroops: totalOrderStroops.toString(),
            buyerRefundStroops: buyerRefundStroops.toString(),
            merchantDisbursementStroops: merchantDisbursementStroops.toString(),
            contractDisbursedBuyer: contractDisbursedBuyer.toString(),
            contractDisbursedMerchant: contractDisbursedMerchant.toString(),
            isBalanced,
            roundingLeakage: roundingLeakage.toString(),
            buyerMatch,
            merchantMatch,
          },
          timestamp: new Date(),
        });
      } else {
        balanced++;

        log.info(`Partial refund balanced for order ${orderId}`, {
          totalOrderStroops: totalOrderStroops.toString(),
          contractDisbursedBuyer: contractDisbursedBuyer.toString(),
          contractDisbursedMerchant: contractDisbursedMerchant.toString(),
        });

        await AuditLog.create({
          action: "partial_refund_balanced",
          details: {
            orderId,
            totalOrderStroops: totalOrderStroops.toString(),
            buyerRefundStroops: buyerRefundStroops.toString(),
            merchantDisbursementStroops: merchantDisbursementStroops.toString(),
            contractDisbursedBuyer: contractDisbursedBuyer.toString(),
            contractDisbursedMerchant: contractDisbursedMerchant.toString(),
          },
          timestamp: new Date(),
        });
      }
    }

    log.info("Partial refund reconciliation complete", {
      processed: records.length,
      balanced,
      discrepancies: discrepancies.length,
    });

    return { processed: records.length, balanced, discrepancies };
  }

  /**
   * Reconcile a single order by ID — convenience wrapper used by API routes
   * and manual triggers.
   */
  async reconcileOrder(orderId: string): Promise<PartialRefundReconciliationResult | null> {
    const { discrepancies, processed } = await this.reconcile([orderId]);

    if (processed === 0) {
      log.warn(`No partial-refund record found for order ${orderId}`);
      return null;
    }

    // If the order was balanced there is no discrepancy entry — return null to
    // signal success to the caller.
    return discrepancies.find((d) => d.orderId === orderId) ?? null;
  }
}

export const partialRefundReconciler = new PartialRefundReconciler();
