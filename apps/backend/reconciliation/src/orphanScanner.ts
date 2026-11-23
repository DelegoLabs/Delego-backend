/**
 * Discrepancy detection engine — orphan transaction scanner (Issue #621).
 *
 * If a buyer pays a platform escrow account directly over Stellar Horizon
 * without going through the web frontend — or an inbound transaction fails
 * mid-flight after being broadcast — the resulting on-chain payment has no
 * corresponding `payment_records` row. This module crawls incoming Horizon
 * payments to the platform's escrow accounts, matches each one to an open
 * pending order by memo (primary) or by buyer address + exact amount
 * (fallback), links confident matches, and quarantines the rest for manual
 * review instead of guessing.
 */
import { createLogger, displayToStroops } from "@delegolabs/utils";
import { sequelize } from "./db.js";
import { OrphanScannerCheckpoint } from "./models/OrphanScannerCheckpoint.js";
import { OrphanedTransactionQuarantine } from "./models/OrphanedTransactionQuarantine.js";

const log = createLogger("reconciliation:orphan-scanner", process.env.LOG_LEVEL ?? "info");

/** Orphaned (unmatched, or not-yet-matched) incoming Horizon payment, as named in the issue. */
export interface OrphanedTransaction {
  txHash: string;
  sourceAccount: string;
  destinationAccount: string;
  amountStroops: string;
  memo?: string;
  ledgerSequence: number;
  matchedOrderId?: string;
}

/** A `payment_records` row still awaiting its on-chain funding transaction. */
export interface PendingOrderCandidate {
  orderId: string;
  buyerAddress: string;
  amountStroops: string;
}

/** One raw operation record from Horizon's `/accounts/{id}/payments?join=transactions` endpoint. */
export interface HorizonPaymentOperationRecord {
  id: string;
  paging_token: string;
  type: string;
  transaction_hash: string;
  transaction_successful?: boolean;
  from?: string;
  to?: string;
  amount?: string;
  asset_type?: string;
  created_at: string;
  transaction?: { memo?: string; memo_type?: string };
}

function getHorizonUrl(): string {
  const network = (process.env.STELLAR_NETWORK ?? "testnet").toLowerCase();
  if (network === "mainnet") return process.env.STELLAR_HORIZON_URL ?? "https://horizon.stellar.org";
  if (network === "futurenet") return process.env.STELLAR_HORIZON_URL ?? "https://horizon-futurenet.stellar.org";
  return process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
}

/** Platform escrow accounts to crawl, from `PLATFORM_ESCROW_ACCOUNTS` (comma-separated G... addresses). */
export function getConfiguredEscrowAccounts(): string[] {
  const raw = process.env.PLATFORM_ESCROW_ACCOUNTS ?? "";
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Stellar's TOID (total order id) paging token encodes the ledger sequence
 * in its upper 32 bits (ledger << 32 | tx-index << 20 | op-index). Decoding
 * it avoids a second Horizon round-trip just to learn which ledger an
 * operation landed in.
 */
export function ledgerSequenceFromPagingToken(pagingToken: string): number {
  return Number(BigInt(pagingToken) >> 32n);
}

async function fetchIncomingPayments(
  horizonUrl: string,
  escrowAccount: string,
  cursor: string,
  fetchImpl: typeof fetch,
  limit = 200
): Promise<HorizonPaymentOperationRecord[]> {
  const url = new URL(`${horizonUrl.replace(/\/$/, "")}/accounts/${escrowAccount}/payments`);
  url.searchParams.set("cursor", cursor);
  url.searchParams.set("order", "asc");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("join", "transactions");

  const response = await fetchImpl(url.toString());
  if (!response.ok) {
    throw new Error(`Horizon payments request failed with status ${response.status}`);
  }

  const body = (await response.json()) as { _embedded?: { records?: HorizonPaymentOperationRecord[] } };
  return body._embedded?.records ?? [];
}

/**
 * Normalize a raw Horizon operation record into an {@link OrphanedTransaction}
 * candidate, or `null` if it's out of scope for this scanner (not a
 * successful native-asset payment *into* the watched escrow account).
 */
export function toOrphanedTransaction(
  record: HorizonPaymentOperationRecord,
  escrowAccount: string
): OrphanedTransaction | null {
  if (record.type !== "payment") return null;
  if (record.transaction_successful === false) return null;
  if (record.to !== escrowAccount) return null;
  if (record.asset_type !== "native" || !record.amount || !record.from) return null;

  return {
    txHash: record.transaction_hash,
    sourceAccount: record.from,
    destinationAccount: record.to,
    amountStroops: displayToStroops(record.amount).toString(),
    memo: record.transaction?.memo_type === "text" ? record.transaction.memo : undefined,
    ledgerSequence: ledgerSequenceFromPagingToken(record.paging_token),
  };
}

/** Open orders still waiting for their on-chain funding payment to arrive. */
export async function loadPendingOrderCandidates(): Promise<PendingOrderCandidate[]> {
  const [rows] = await sequelize.query(`
    SELECT order_id, buyer_address, amount_stroops
    FROM payment_records
    WHERE status = 'pending' AND fund_tx_hash IS NULL
  `);

  return (rows as Array<{ order_id: string; buyer_address: string; amount_stroops: string | number }>).map((row) => ({
    orderId: row.order_id,
    buyerAddress: row.buyer_address,
    amountStroops: String(row.amount_stroops),
  }));
}

/**
 * Match an orphaned transaction to exactly one pending order — memo first
 * (the memo is expected to carry the order id), falling back to buyer
 * address + exact amount. Either path requires an *unambiguous* single
 * match; anything else is left unmatched so it gets quarantined rather than
 * linked on a guess.
 */
export function matchOrphanedTransaction(
  tx: Pick<OrphanedTransaction, "memo" | "amountStroops" | "sourceAccount">,
  candidates: PendingOrderCandidate[]
): string | null {
  if (tx.memo) {
    const byMemo = candidates.filter((candidate) => candidate.orderId === tx.memo);
    if (byMemo.length === 1 && byMemo[0].amountStroops === tx.amountStroops) {
      return byMemo[0].orderId;
    }
  }

  const byBuyerAndAmount = candidates.filter(
    (candidate) => candidate.amountStroops === tx.amountStroops && candidate.buyerAddress === tx.sourceAccount
  );
  if (byBuyerAndAmount.length === 1) {
    return byBuyerAndAmount[0].orderId;
  }

  return null;
}

async function linkOrphanedTransactionToOrder(tx: OrphanedTransaction & { matchedOrderId: string }): Promise<void> {
  await sequelize.query(
    `UPDATE payment_records
     SET fund_tx_hash = :txHash, status = 'funded', updated_at = NOW()
     WHERE order_id = :orderId AND fund_tx_hash IS NULL`,
    { replacements: { txHash: tx.txHash, orderId: tx.matchedOrderId } }
  );
  log.info("Matched orphaned transaction to pending order", {
    txHash: tx.txHash,
    orderId: tx.matchedOrderId,
    amountStroops: tx.amountStroops,
  });
}

async function quarantineOrphanedTransaction(tx: OrphanedTransaction): Promise<void> {
  // `tx_hash` (not the surrogate `id` PK) is the natural dedup key, so repeated
  // scans upsert the same row instead of violating its unique constraint —
  // Postgres only suppresses conflicts on the constraint `conflictFields` names.
  await OrphanedTransactionQuarantine.upsert(
    {
      txHash: tx.txHash,
      sourceAccount: tx.sourceAccount,
      destinationAccount: tx.destinationAccount,
      amountStroops: tx.amountStroops,
      memo: tx.memo ?? null,
      ledgerSequence: tx.ledgerSequence,
      status: "pending_review",
    },
    { conflictFields: ["tx_hash"] } as any
  );
  log.warn("Quarantined unmatched incoming escrow payment", {
    txHash: tx.txHash,
    destinationAccount: tx.destinationAccount,
    amountStroops: tx.amountStroops,
  });
}

export interface OrphanScanResult {
  scanned: number;
  matched: number;
  quarantined: number;
}

export interface OrphanScanOptions {
  escrowAccounts?: string[];
  fetchImpl?: typeof fetch;
  pageLimit?: number;
}

/**
 * Crawl every configured platform escrow account for incoming payments since
 * its last checkpoint, matching or quarantining each one. Safe to run
 * repeatedly/concurrently-ish: the checkpoint advances per page, and both
 * the match (idempotent `WHERE fund_tx_hash IS NULL` update) and quarantine
 * (`upsert` on the unique `tx_hash`) writes are safe to repeat.
 */
export async function scanForOrphanedTransactions(options: OrphanScanOptions = {}): Promise<OrphanScanResult> {
  const escrowAccounts = options.escrowAccounts ?? getConfiguredEscrowAccounts();
  const fetchImpl = options.fetchImpl ?? fetch;
  const pageLimit = options.pageLimit ?? 200;
  const horizonUrl = getHorizonUrl();

  if (escrowAccounts.length === 0) {
    log.warn("No platform escrow accounts configured (PLATFORM_ESCROW_ACCOUNTS) — skipping orphan scan");
    return { scanned: 0, matched: 0, quarantined: 0 };
  }

  const candidates = await loadPendingOrderCandidates();
  const result: OrphanScanResult = { scanned: 0, matched: 0, quarantined: 0 };

  for (const escrowAccount of escrowAccounts) {
    const checkpoint = await OrphanScannerCheckpoint.findByPk(escrowAccount);
    let cursor = checkpoint?.lastCursor ?? "0";

    for (;;) {
      const records = await fetchIncomingPayments(horizonUrl, escrowAccount, cursor, fetchImpl, pageLimit);
      if (records.length === 0) break;

      for (const record of records) {
        cursor = record.paging_token;

        const tx = toOrphanedTransaction(record, escrowAccount);
        if (!tx) continue;

        result.scanned += 1;
        const matchedOrderId = matchOrphanedTransaction(tx, candidates);
        if (matchedOrderId) {
          await linkOrphanedTransactionToOrder({ ...tx, matchedOrderId });
          result.matched += 1;
        } else {
          await quarantineOrphanedTransaction(tx);
          result.quarantined += 1;
        }
      }

      await OrphanScannerCheckpoint.upsert({ escrowAccount, lastCursor: cursor, syncedAt: new Date() });

      if (records.length < pageLimit) break;
    }
  }

  log.info("Orphan scan completed", result);
  return result;
}

const DEFAULT_SCAN_INTERVAL_MS = 2 * 60 * 1000; // well under the 5-minute acceptance target
let workerHandle: NodeJS.Timeout | undefined;

/** Start the recurring orphan scan loop (scans once immediately, then every `intervalMs`). */
export function startOrphanScannerWorker(intervalMs: number = DEFAULT_SCAN_INTERVAL_MS): void {
  if (workerHandle) return;

  void scanForOrphanedTransactions().catch((err) =>
    log.error("Initial orphan scan failed", { error: err instanceof Error ? err.message : String(err) })
  );

  workerHandle = setInterval(() => {
    void scanForOrphanedTransactions().catch((err) =>
      log.error("Scheduled orphan scan failed", { error: err instanceof Error ? err.message : String(err) })
    );
  }, intervalMs);
  workerHandle.unref?.();
}

/** Stop the recurring orphan scan loop (used on graceful shutdown and in tests). */
export function stopOrphanScannerWorker(): void {
  if (workerHandle) {
    clearInterval(workerHandle);
    workerHandle = undefined;
  }
}
