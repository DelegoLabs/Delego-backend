/**
 * Blend Yield Accrual Event Listener — Issue #606.
 *
 * Long-duration escrows can earn yield via integration with the Blend
 * protocol. This listener consumes `YieldDistributed` events emitted onto
 * the shared Soroban events Redis stream, records each distribution (split
 * between buyer and merchant shares) against the owning order, keeps the
 * order's running total in sync with newly accrued yield, and disburses
 * accrued yield once the underlying escrow has settled.
 *
 * Event flow:
 *   1. Soroban ingestion worker emits `yield_distributed` events to the
 *      shared Redis stream (same stream the contract-upgrade listener reads).
 *   2. This handler resolves the event's `escrowId` to its owning order via
 *      `payment_records`, persists the distribution, and adds the new
 *      (accrued - previously recorded) yield delta onto `orders.total_stroops`.
 *   3. If the escrow has already settled (`payment_records.status` is a
 *      terminal state), the distribution is marked disbursed immediately;
 *      otherwise it stays pending until `disburseYieldForEscrow` is called
 *      when the escrow completes.
 */

import { createLogger, type Logger } from "@delegolabs/utils";
import { Redis } from "ioredis";
import type { Pool } from "pg";

export interface BlendYieldEvent {
  escrowId: string;
  poolId: string;
  accruedYieldStroops: string;
  buyerYieldShareStroops: string;
  merchantYieldShareStroops: string;
  timestamp: string;
}

export interface YieldDistributionRecord {
  id: string;
  escrowId: string;
  orderId: string | null;
  poolId: string;
  accruedYieldStroops: string;
  buyerYieldShareStroops: string;
  merchantYieldShareStroops: string;
  eventTimestamp: string;
  txHash: string | null;
  disbursed: boolean;
  disbursedAt: string | null;
}

export interface BlendYieldListenerConfig {
  redis: Redis;
  pgPool: Pool;
  pollIntervalMs?: number;
  consumerGroup?: string;
  consumerName?: string;
  logger?: Logger;
}

const YIELD_EVENT_TOPIC = "yield_distributed";
const REDIS_STREAM_KEY = "soroban:events";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_CONSUMER_GROUP = "blend-yield-listener";

/** Escrow (payment_records) statuses that mean the escrow has finished its lifecycle. */
const TERMINAL_ESCROW_STATUSES = new Set(["released", "refunded"]);

export class BlendYieldListener {
  private readonly redis: Redis;
  private readonly pgPool: Pool;
  private readonly pollIntervalMs: number;
  private readonly consumerGroup: string;
  private readonly consumerName: string;
  private readonly log: Logger;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEventId = "0-0";

  constructor(config: BlendYieldListenerConfig) {
    this.redis = config.redis;
    this.pgPool = config.pgPool;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.consumerGroup = config.consumerGroup ?? DEFAULT_CONSUMER_GROUP;
    this.consumerName = config.consumerName ?? `blend-yield-${process.pid}`;
    this.log = config.logger ?? createLogger("cdc:blendYield", process.env.LOG_LEVEL ?? "info");
  }

  async start(): Promise<void> {
    if (this.running) {
      this.log.warn("Blend yield listener already running");
      return;
    }
    this.log.info("Starting Blend yield accrual listener");
    await this.ensureConsumerGroup();
    this.running = true;
    this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.log.info("Blend yield accrual listener stopped");
  }

  private async ensureConsumerGroup(): Promise<void> {
    try {
      await this.redis.xgroup("CREATE", REDIS_STREAM_KEY, this.consumerGroup, "0", "MKSTREAM");
    } catch (err) {
      if (err instanceof Error && !err.message.includes("BUSYGROUP")) {
        throw err;
      }
    }
  }

  private poll(): void {
    if (!this.running) return;
    this.consumeEvents()
      .catch((err) => {
        this.log.error("Error consuming Blend yield events", {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        if (this.running) {
          this.pollTimer = setTimeout(() => this.poll(), this.pollIntervalMs);
        }
      });
  }

  private async consumeEvents(): Promise<void> {
    const result = (await this.redis.xreadgroup(
      "GROUP",
      this.consumerGroup,
      this.consumerName,
      "COUNT",
      "50",
      "BLOCK",
      "5000",
      "STREAMS",
      REDIS_STREAM_KEY,
      ">",
    )) as Array<[string, Array<[string, string[]]>]> | null;

    if (!result) return;

    for (const [, messages] of result) {
      for (const [messageId, fields] of messages) {
        this.lastEventId = messageId;
        await this.processMessage(messageId, fields);
      }
    }
  }

  private async processMessage(messageId: string, fields: string[]): Promise<void> {
    const data: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      data[fields[i]] = fields[i + 1];
    }

    if (data.topic !== YIELD_EVENT_TOPIC) {
      await this.redis.xack(REDIS_STREAM_KEY, this.consumerGroup, messageId);
      return;
    }

    try {
      const event = this.parseYieldEvent(data);
      await this.handleYieldEvent(event, data.txHash);
      await this.redis.xack(REDIS_STREAM_KEY, this.consumerGroup, messageId);
    } catch (err) {
      this.log.error("Failed to process Blend yield event", {
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Don't ack — let it be redelivered.
      throw err;
    }
  }

  private parseYieldEvent(data: Record<string, string>): BlendYieldEvent {
    const eventData = JSON.parse(data.data) as Record<string, unknown>;
    const event: BlendYieldEvent = {
      escrowId: String(eventData.escrowId ?? eventData.escrow_id ?? data.escrowId ?? ""),
      poolId: String(eventData.poolId ?? eventData.pool_id ?? ""),
      accruedYieldStroops: String(eventData.accruedYieldStroops ?? eventData.accrued_yield_stroops ?? "0"),
      buyerYieldShareStroops: String(
        eventData.buyerYieldShareStroops ?? eventData.buyer_yield_share_stroops ?? "0",
      ),
      merchantYieldShareStroops: String(
        eventData.merchantYieldShareStroops ?? eventData.merchant_yield_share_stroops ?? "0",
      ),
      timestamp: String(eventData.timestamp ?? data.timestamp ?? new Date().toISOString()),
    };

    if (!event.escrowId) {
      throw new Error("Blend yield event is missing escrowId");
    }
    if (!/^\d+$/.test(event.accruedYieldStroops)) {
      throw new Error(`Blend yield event has a non-integer accruedYieldStroops: ${event.accruedYieldStroops}`);
    }

    // Data-integrity check: the buyer/merchant shares should sum to the
    // accrued total. A mismatch doesn't block persistence (the raw event is
    // still recorded for audit) but is surfaced loudly, since silently
    // mis-attributing yield between buyer and merchant is a real financial bug.
    const total = BigInt(event.accruedYieldStroops);
    const buyerShare = BigInt(event.buyerYieldShareStroops || "0");
    const merchantShare = BigInt(event.merchantYieldShareStroops || "0");
    if (buyerShare + merchantShare !== total) {
      this.log.warn("Blend yield shares do not sum to accrued total", {
        escrowId: event.escrowId,
        accruedYieldStroops: event.accruedYieldStroops,
        buyerYieldShareStroops: event.buyerYieldShareStroops,
        merchantYieldShareStroops: event.merchantYieldShareStroops,
      });
    }

    return event;
  }

  private async handleYieldEvent(event: BlendYieldEvent, txHash?: string): Promise<void> {
    const escrow = await this.pgPool.query<{ order_id: string; status: string }>(
      `SELECT order_id, status FROM payment_records WHERE escrow_id = $1`,
      [event.escrowId],
    );

    const orderId = escrow.rows[0]?.order_id ?? null;
    const escrowStatus = escrow.rows[0]?.status;
    const isSettled = escrowStatus ? TERMINAL_ESCROW_STATUSES.has(escrowStatus) : false;

    const client = await this.pgPool.connect();
    try {
      await client.query("BEGIN");

      // Previously recorded cumulative accrual for this escrow (if any), so
      // we can post only the *delta* onto the order's running total instead
      // of double-counting on every event.
      const previous = await client.query<{ accrued_yield_stroops: string }>(
        `SELECT accrued_yield_stroops FROM escrow_yield_distributions
           WHERE escrow_id = $1
           ORDER BY event_timestamp DESC
           LIMIT 1`,
        [event.escrowId],
      );
      const previousAccrued = BigInt(previous.rows[0]?.accrued_yield_stroops ?? "0");
      const currentAccrued = BigInt(event.accruedYieldStroops);
      const delta = currentAccrued > previousAccrued ? currentAccrued - previousAccrued : 0n;

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO escrow_yield_distributions
           (escrow_id, order_id, pool_id, accrued_yield_stroops, buyer_yield_share_stroops,
            merchant_yield_share_stroops, event_timestamp, tx_hash, disbursed, disbursed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (escrow_id, event_timestamp) DO NOTHING
         RETURNING id`,
        [
          event.escrowId,
          orderId,
          event.poolId,
          event.accruedYieldStroops,
          event.buyerYieldShareStroops,
          event.merchantYieldShareStroops,
          event.timestamp,
          txHash ?? null,
          isSettled,
          isSettled ? new Date().toISOString() : null,
        ],
      );

      // Already processed this exact event (redelivery) — nothing further to do.
      if (inserted.rows.length === 0) {
        await client.query("ROLLBACK");
        return;
      }

      if (orderId && delta > 0n) {
        await client.query(
          `UPDATE orders SET total_stroops = total_stroops + $2, updated_at = NOW() WHERE id = $1`,
          [orderId, delta.toString()],
        );
      }

      await client.query("COMMIT");

      this.log.info("Recorded Blend yield distribution", {
        escrowId: event.escrowId,
        orderId,
        poolId: event.poolId,
        accruedYieldStroops: event.accruedYieldStroops,
        delta: delta.toString(),
        disbursed: isSettled,
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    if (isSettled) {
      await this.disburseYieldForEscrow(event.escrowId);
    }
  }

  /**
   * Marks every undisbursed yield distribution for an escrow as disbursed.
   * Called automatically once a yield event arrives after the escrow has
   * already settled, and safe to call directly from the escrow-release flow
   * when settlement happens after yield has already accrued.
   */
  async disburseYieldForEscrow(escrowId: string): Promise<number> {
    const result = await this.pgPool.query(
      `UPDATE escrow_yield_distributions
         SET disbursed = TRUE, disbursed_at = NOW()
       WHERE escrow_id = $1 AND disbursed = FALSE`,
      [escrowId],
    );
    const count = result.rowCount ?? 0;
    if (count > 0) {
      this.log.info("Disbursed accrued Blend yield on escrow completion", { escrowId, distributions: count });
    }
    return count;
  }

  async getDistributionsForEscrow(escrowId: string): Promise<YieldDistributionRecord[]> {
    const res = await this.pgPool.query<{
      id: string;
      escrow_id: string;
      order_id: string | null;
      pool_id: string;
      accrued_yield_stroops: string;
      buyer_yield_share_stroops: string;
      merchant_yield_share_stroops: string;
      event_timestamp: Date;
      tx_hash: string | null;
      disbursed: boolean;
      disbursed_at: Date | null;
    }>(
      `SELECT * FROM escrow_yield_distributions WHERE escrow_id = $1 ORDER BY event_timestamp ASC`,
      [escrowId],
    );

    return res.rows.map((row) => ({
      id: row.id,
      escrowId: row.escrow_id,
      orderId: row.order_id,
      poolId: row.pool_id,
      accruedYieldStroops: row.accrued_yield_stroops,
      buyerYieldShareStroops: row.buyer_yield_share_stroops,
      merchantYieldShareStroops: row.merchant_yield_share_stroops,
      eventTimestamp: row.event_timestamp.toISOString(),
      txHash: row.tx_hash,
      disbursed: row.disbursed,
      disbursedAt: row.disbursed_at ? row.disbursed_at.toISOString() : null,
    }));
  }

  getStatus(): { running: boolean; lastEventId: string } {
    return { running: this.running, lastEventId: this.lastEventId };
  }
}

export function createBlendYieldListener(config: BlendYieldListenerConfig): BlendYieldListener {
  return new BlendYieldListener(config);
}
