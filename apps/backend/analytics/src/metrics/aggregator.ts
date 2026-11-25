import { QueryTypes, type Sequelize } from "sequelize";
import { createLogger } from "@delegolabs/utils";
import { sequelize } from "../db.js";

export const SPEND_AGGREGATION_INTERVAL_MS = 60 * 60 * 1000;
const log = createLogger("analytics:spend", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Issue #494 — Scheduler configuration contract
// ---------------------------------------------------------------------------

/**
 * Configuration for the spend-metrics aggregation scheduler.
 *
 * `onShutdown` is called by {@link startSpendMetricsAggregator}'s `stop()`
 * after the timer is cleared and any in-flight batch resolves, so callers
 * (Fastify `onClose`, process `SIGTERM` handlers) can await a clean exit.
 */
export interface SpendMetricsSchedulerConfig {
  intervalMs: number;
  batchSize: number;
  retentionDays: number;
  onShutdown: () => Promise<void>;
}

/**
 * A single aggregated spend window returned by the aggregator.
 */
export interface AggregatedSpendWindow {
  windowStart: string;
  windowEnd: string;
  agentId: string;
  totalSpentStroops: string;
  transactionCount: number;
}

/** Rebuild both granularities from one snapshot, including late settlements.
 * DELETE (rather than TRUNCATE) lets dashboard readers keep the previous
 * committed summaries until the entire refresh commits. A failed refresh
 * rolls back, and the transaction lock prevents concurrent replica refreshes.
 */
export async function aggregateSpendMetrics(db: Sequelize = sequelize): Promise<boolean> {
  return db.transaction(async (transaction) => {
    const [lock] = await db.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(306, 1) AS acquired",
      { transaction, type: QueryTypes.SELECT },
    );
    if (!lock.acquired) return false;

    await db.query(`
      CREATE TEMP TABLE spend_daily_snapshot ON COMMIT DROP AS
      SELECT (p.updated_at AT TIME ZONE 'UTC')::date AS date,
             o.user_id,
             COALESCE(NULLIF(m.category, ''), 'uncategorized') AS category,
             SUM(p.amount_stroops - p.refunded_amount_stroops)::bigint AS total_spent_stroops,
             COUNT(*)::int AS orders_count
      FROM payment_records p
      JOIN orders o ON o.id = p.order_id
      LEFT JOIN merchants m ON m.id::text = o.merchant_id
      WHERE p.status = 'released' AND p.updated_at IS NOT NULL
      GROUP BY 1, 2, 3
    `, { transaction });

    await db.query("DELETE FROM daily_spend_metrics", { transaction });
    await db.query(`
      INSERT INTO daily_spend_metrics (date, user_id, category, total_spent_stroops, orders_count)
      SELECT date, user_id, category, total_spent_stroops, orders_count
      FROM spend_daily_snapshot
    `, { transaction });
    await db.query("DELETE FROM monthly_spend_metrics", { transaction });
    await db.query(`
      INSERT INTO monthly_spend_metrics (month, user_id, category, total_spent_stroops, orders_count)
      SELECT date_trunc('month', date::timestamp)::date, user_id, category,
             SUM(total_spent_stroops)::bigint, SUM(orders_count)::int
      FROM spend_daily_snapshot
      GROUP BY 1, 2, 3
    `, { transaction });
    return true;
  });
}

/**
 * Run at startup and on each `intervalMs` tick; stop waits for any active
 * batch to finish before resolving so the process can exit cleanly.
 *
 * Accepts an optional {@link SpendMetricsSchedulerConfig} for integration
 * with Fastify's `onClose` / SIGTERM lifecycle. When only a `refresh`
 * function is provided (the common test pattern) the defaults apply.
 */
export function startSpendMetricsAggregator(
  refresh: () => Promise<boolean> = aggregateSpendMetrics,
  config?: Partial<SpendMetricsSchedulerConfig>,
): { stop: () => Promise<void> } {
  const intervalMs = config?.intervalMs ?? SPEND_AGGREGATION_INTERVAL_MS;
  let active: Promise<void> | undefined;
  let stopping = false;

  const run = () => {
    if (active) return;
    active = Promise.resolve().then(refresh).then((updated) => {
      if (updated) log.info("Spend summaries refreshed");
    }).catch((error: unknown) => {
      // Suppress error logs during/after shutdown — the scheduler is being torn
      // down intentionally; log noise here causes test warnings (Issue #494).
      if (!stopping) {
        log.error("Spend summary refresh failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }).finally(() => { active = undefined; });
  };

  run();
  const timer = setInterval(run, intervalMs);
  // Unref so the timer never keeps the Node process alive on its own.
  timer.unref();

  return {
    async stop() {
      stopping = true;
      clearInterval(timer);
      // Await any in-flight batch so the process can exit within the
      // 5-second window required by the integration test runners.
      await active;
      await config?.onShutdown?.();
    },
  };
}
