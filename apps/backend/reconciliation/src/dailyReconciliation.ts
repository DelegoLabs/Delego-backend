/**
 * Daily automated ledger reconciliation between PostgreSQL and Soroban (Issue #620).
 *
 * Loads the previous UTC day's settled orders from `payment_records`, batch
 * reads the matching escrow entries from Soroban contract storage over
 * JSON-RPC (`getLedgerEntries`, 200 keys per request, several requests in
 * flight), and compares amount and status for each order. The result is a
 * JSON {@link ReconciliationReport}; any discrepancy is logged as an audit
 * trail line and raised through the alert hook.
 *
 * All amounts are handled as BigInt stroops and serialized as strings.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "@delegolabs/utils";
import { sequelize } from "./db.js";

const log = createLogger("reconciliation:daily-ledger", process.env.LOG_LEVEL ?? "info");

export interface ReconciliationDiscrepancy {
  orderId: string;
  dbAmountStroops: string;
  onChainAmountStroops: string;
  dbStatus: string;
  onChainStatus: string;
  differenceStroops: string;
}

export interface ReconciliationReport {
  reportDate: string;
  totalOrdersChecked: number;
  perfectMatches: number;
  discrepancies: ReconciliationDiscrepancy[];
  totalDiscrepancyAmountStroops: string;
}

/** A settled order as recorded in PostgreSQL. */
export interface DbSettledOrder {
  orderId: string;
  escrowId: string;
  amountStroops: bigint;
  status: string;
}

/** Escrow state as stored in the Soroban contract. */
export interface OnChainEscrowState {
  amountStroops: bigint;
  status: string;
}

/** Resolves on-chain state for escrow ids; ids absent from the result are treated as missing on-chain. */
export type OnChainEscrowReader = (escrowIds: string[]) => Promise<Map<string, OnChainEscrowState>>;

export type ReconciliationAlert = (report: ReconciliationReport) => Promise<void> | void;

/** Soroban RPC caps `getLedgerEntries` at 200 keys per call. */
export const SOROBAN_MAX_KEYS_PER_REQUEST = 200;
const DEFAULT_RPC_CONCURRENCY = 8;
const MISSING_ON_CHAIN_STATUS = "missing";

/** UTC date (YYYY-MM-DD) that the report covers: the day before `now`. */
export function reportDateFor(now: Date): string {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return day.toISOString().slice(0, 10);
}

/** Query orders settled during the given UTC day (`reportDate`, YYYY-MM-DD). */
export async function loadSettledOrders(reportDate: string): Promise<DbSettledOrder[]> {
  const [rows] = await sequelize.query(
    `SELECT order_id, escrow_id, amount_stroops, status
     FROM payment_records
     WHERE status = 'released'
       AND escrow_id IS NOT NULL
       AND updated_at >= :start::timestamptz
       AND updated_at < (:start::timestamptz + INTERVAL '1 day')
     ORDER BY order_id`,
    { replacements: { start: `${reportDate}T00:00:00Z` } }
  );

  return (
    rows as Array<{ order_id: string; escrow_id: string; amount_stroops: string | number | bigint; status: string }>
  ).map((row) => ({
    orderId: row.order_id,
    escrowId: row.escrow_id,
    amountStroops: BigInt(row.amount_stroops),
    status: row.status,
  }));
}

export interface SorobanRpcReaderOptions {
  rpcUrl?: string;
  /** Build the base64 XDR ledger key for an escrow id. */
  buildKey: (escrowId: string) => string;
  /** Decode a returned ledger entry (`key` echoes the requested key); null when it is not a valid escrow. */
  decodeEntry: (entry: { key: string; xdr: string }) => { escrowId: string; state: OnChainEscrowState } | null;
  fetchImpl?: typeof fetch;
  batchSize?: number;
  concurrency?: number;
}

/**
 * Create an {@link OnChainEscrowReader} that batches `getLedgerEntries`
 * calls. The contract's key layout and value encoding are supplied by the
 * caller, keeping this module independent of the escrow contract's ABI.
 */
export function createSorobanRpcReader(options: SorobanRpcReaderOptions): OnChainEscrowReader {
  const rpcUrl = options.rpcUrl ?? process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const fetchImpl = options.fetchImpl ?? fetch;
  const batchSize = Math.min(options.batchSize ?? SOROBAN_MAX_KEYS_PER_REQUEST, SOROBAN_MAX_KEYS_PER_REQUEST);
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_RPC_CONCURRENCY);

  async function fetchBatch(escrowIds: string[]): Promise<Array<{ escrowId: string; state: OnChainEscrowState }>> {
    const response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getLedgerEntries",
        params: { keys: escrowIds.map(options.buildKey) },
      }),
    });
    if (!response.ok) {
      throw new Error(`Soroban RPC getLedgerEntries failed with status ${response.status}`);
    }
    const body = (await response.json()) as {
      result?: { entries?: Array<{ key: string; xdr: string }> | null };
      error?: { message?: string };
    };
    if (body.error) {
      throw new Error(`Soroban RPC error: ${body.error.message ?? "unknown"}`);
    }

    const decoded: Array<{ escrowId: string; state: OnChainEscrowState }> = [];
    for (const entry of body.result?.entries ?? []) {
      const item = options.decodeEntry(entry);
      if (item) decoded.push(item);
    }
    return decoded;
  }

  return async (escrowIds) => {
    const batches: string[][] = [];
    for (let i = 0; i < escrowIds.length; i += batchSize) {
      batches.push(escrowIds.slice(i, i + batchSize));
    }

    const result = new Map<string, OnChainEscrowState>();
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        for (const item of await fetchBatch(batch)) {
          result.set(item.escrowId, item.state);
        }
      }
    });
    await Promise.all(workers);
    return result;
  };
}

/** Compare DB orders against on-chain state and build the report. */
export function buildReconciliationReport(
  reportDate: string,
  orders: DbSettledOrder[],
  onChain: Map<string, OnChainEscrowState>
): ReconciliationReport {
  const discrepancies: ReconciliationDiscrepancy[] = [];
  let totalDiscrepancy = 0n;

  for (const order of orders) {
    const chain = onChain.get(order.escrowId);
    const onChainAmount = chain?.amountStroops ?? 0n;
    const onChainStatus = chain?.status ?? MISSING_ON_CHAIN_STATUS;

    if (chain && onChainAmount === order.amountStroops && onChainStatus === order.status) continue;

    const difference = onChainAmount - order.amountStroops;
    totalDiscrepancy += difference < 0n ? -difference : difference;
    discrepancies.push({
      orderId: order.orderId,
      dbAmountStroops: order.amountStroops.toString(),
      onChainAmountStroops: onChainAmount.toString(),
      dbStatus: order.status,
      onChainStatus,
      differenceStroops: difference.toString(),
    });
  }

  return {
    reportDate,
    totalOrdersChecked: orders.length,
    perfectMatches: orders.length - discrepancies.length,
    discrepancies,
    totalDiscrepancyAmountStroops: totalDiscrepancy.toString(),
  };
}

/** Default alert: error log plus an optional JSON webhook (`RECONCILIATION_ALERT_WEBHOOK_URL`). */
export async function defaultAlert(report: ReconciliationReport, fetchImpl: typeof fetch = fetch): Promise<void> {
  log.error("Ledger reconciliation found discrepancies", {
    reportDate: report.reportDate,
    discrepancyCount: report.discrepancies.length,
    totalDiscrepancyAmountStroops: report.totalDiscrepancyAmountStroops,
  });

  const webhookUrl = process.env.RECONCILIATION_ALERT_WEBHOOK_URL;
  if (!webhookUrl) return;

  const response = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `Delego ledger reconciliation ${report.reportDate}: ${report.discrepancies.length} discrepancies, ${report.totalDiscrepancyAmountStroops} stroops`,
      report,
    }),
  });
  if (!response.ok) {
    throw new Error(`Reconciliation alert webhook failed with status ${response.status}`);
  }
}

export interface DailyReconciliationOptions {
  now?: Date;
  /** Override the DB query (defaults to {@link loadSettledOrders}). */
  loadOrders?: (reportDate: string) => Promise<DbSettledOrder[]>;
  readOnChain: OnChainEscrowReader;
  alert?: ReconciliationAlert;
  /** Directory to write `reconciliation-<date>.json` into (defaults to `RECONCILIATION_REPORT_DIR`). */
  reportDir?: string;
}

/** Run one reconciliation pass and return the report. */
export async function runDailyLedgerReconciliation(options: DailyReconciliationOptions): Promise<ReconciliationReport> {
  const reportDate = reportDateFor(options.now ?? new Date());
  const startedAt = Date.now();
  log.info("Starting daily ledger reconciliation", { reportDate });

  const orders = await (options.loadOrders ?? loadSettledOrders)(reportDate);
  const onChain = orders.length > 0 ? await options.readOnChain([...new Set(orders.map((o) => o.escrowId))]) : new Map();
  const report = buildReconciliationReport(reportDate, orders, onChain);

  for (const d of report.discrepancies) {
    log.warn("Ledger discrepancy", { ...d });
  }

  const reportDir = options.reportDir ?? process.env.RECONCILIATION_REPORT_DIR;
  if (reportDir) {
    await mkdir(reportDir, { recursive: true });
    await writeFile(path.join(reportDir, `reconciliation-${reportDate}.json`), JSON.stringify(report, null, 2));
  }

  if (report.discrepancies.length > 0) {
    await (options.alert ?? defaultAlert)(report);
  }

  log.info("Daily ledger reconciliation completed", {
    reportDate,
    totalOrdersChecked: report.totalOrdersChecked,
    perfectMatches: report.perfectMatches,
    discrepancies: report.discrepancies.length,
    durationMs: Date.now() - startedAt,
  });
  return report;
}
