/**
 * Per-billing-period charge ledger (Issue #47).
 *
 * One row per (subscriptionId, periodStart) — a scheduler re-run for the
 * same period updates the existing row instead of creating a duplicate, so
 * a retried billing pass can never double-charge a period.
 * Postgres-backed (`subscription_charges` from migration 017) in
 * production; in-memory default for tests/local dev.
 */

import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("payments:subscriptions:charge-store", process.env.LOG_LEVEL ?? "info");

export type ChargeStatus = "pending" | "succeeded" | "failed";

export interface SubscriptionCharge {
  id: string;
  subscriptionId: string;
  periodStart: string;
  periodEnd: string;
  amount: string;
  status: ChargeStatus;
  escrowId?: string;
  fundTxHash?: string;
  releaseTxHash?: string;
  failureReason?: string;
  attemptCount: number;
}

export interface UpsertChargeInput {
  subscriptionId: string;
  periodStart: string;
  periodEnd: string;
  amount: string;
}

export interface ChargeUpdate {
  status?: ChargeStatus;
  escrowId?: string;
  fundTxHash?: string;
  releaseTxHash?: string;
  failureReason?: string | null;
}

export interface ChargeStore {
  /** Finds the existing charge attempt for this period, or creates a fresh "pending" one. */
  getOrCreate(input: UpsertChargeInput): Promise<SubscriptionCharge>;
  update(id: string, update: ChargeUpdate): Promise<SubscriptionCharge>;
  incrementAttempt(id: string): Promise<SubscriptionCharge>;
}

export class InMemoryChargeStore implements ChargeStore {
  private readonly charges = new Map<string, SubscriptionCharge>();
  private readonly byPeriod = new Map<string, string>();

  private periodKey(subscriptionId: string, periodStart: string): string {
    return `${subscriptionId}:${periodStart}`;
  }

  async getOrCreate(input: UpsertChargeInput): Promise<SubscriptionCharge> {
    const periodKey = this.periodKey(input.subscriptionId, input.periodStart);
    const existingId = this.byPeriod.get(periodKey);
    if (existingId) {
      return { ...this.charges.get(existingId)! };
    }

    const charge: SubscriptionCharge = {
      id: randomUUID(),
      subscriptionId: input.subscriptionId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      amount: input.amount,
      status: "pending",
      attemptCount: 0,
    };
    this.charges.set(charge.id, charge);
    this.byPeriod.set(periodKey, charge.id);
    return { ...charge };
  }

  async update(id: string, update: ChargeUpdate): Promise<SubscriptionCharge> {
    const existing = this.charges.get(id);
    if (!existing) throw new Error(`Subscription charge not found: ${id}`);
    const updated: SubscriptionCharge = {
      ...existing,
      status: update.status ?? existing.status,
      escrowId: update.escrowId ?? existing.escrowId,
      fundTxHash: update.fundTxHash ?? existing.fundTxHash,
      releaseTxHash: update.releaseTxHash ?? existing.releaseTxHash,
      failureReason: update.failureReason === null ? undefined : (update.failureReason ?? existing.failureReason),
    };
    this.charges.set(id, updated);
    return { ...updated };
  }

  async incrementAttempt(id: string): Promise<SubscriptionCharge> {
    const existing = this.charges.get(id);
    if (!existing) throw new Error(`Subscription charge not found: ${id}`);
    const updated = { ...existing, attemptCount: existing.attemptCount + 1 };
    this.charges.set(id, updated);
    return { ...updated };
  }
}

interface ChargeRow extends QueryResultRow {
  id: string;
  subscription_id: string;
  period_start: Date;
  period_end: Date;
  amount_stroops: string;
  status: ChargeStatus;
  escrow_id: string | null;
  fund_tx_hash: string | null;
  release_tx_hash: string | null;
  failure_reason: string | null;
  attempt_count: number;
}

function mapRow(row: ChargeRow): SubscriptionCharge {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    periodStart: row.period_start.toISOString(),
    periodEnd: row.period_end.toISOString(),
    amount: row.amount_stroops,
    status: row.status,
    escrowId: row.escrow_id ?? undefined,
    fundTxHash: row.fund_tx_hash ?? undefined,
    releaseTxHash: row.release_tx_hash ?? undefined,
    failureReason: row.failure_reason ?? undefined,
    attemptCount: row.attempt_count,
  };
}

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const databaseUrl = process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego";
    pool = new Pool({ connectionString: databaseUrl });
  }
  return pool;
}

export function _setPoolForTesting(testPool: Pool): void {
  pool = testPool;
}

export function _resetPoolForTesting(): void {
  pool = null;
}

export class PostgresChargeStore implements ChargeStore {
  async getOrCreate(input: UpsertChargeInput): Promise<SubscriptionCharge> {
    const { rows } = await getPool().query<ChargeRow>(
      `INSERT INTO subscription_charges (subscription_id, period_start, period_end, amount_stroops)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (subscription_id, period_start) DO UPDATE SET subscription_id = EXCLUDED.subscription_id
       RETURNING *`,
      [input.subscriptionId, input.periodStart, input.periodEnd, input.amount]
    );
    return mapRow(rows[0]);
  }

  async update(id: string, update: ChargeUpdate): Promise<SubscriptionCharge> {
    const fields: string[] = [];
    const values: unknown[] = [id];
    const addField = (column: string, value: unknown) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };

    if (update.status !== undefined) addField("status", update.status);
    if (update.escrowId !== undefined) addField("escrow_id", update.escrowId);
    if (update.fundTxHash !== undefined) addField("fund_tx_hash", update.fundTxHash);
    if (update.releaseTxHash !== undefined) addField("release_tx_hash", update.releaseTxHash);
    if (update.failureReason !== undefined) addField("failure_reason", update.failureReason);
    fields.push("updated_at = NOW()");

    const { rows } = await getPool().query<ChargeRow>(
      `UPDATE subscription_charges SET ${fields.join(", ")} WHERE id = $1 RETURNING *`,
      values
    );
    if (!rows[0]) throw new Error(`Subscription charge not found: ${id}`);
    return mapRow(rows[0]);
  }

  async incrementAttempt(id: string): Promise<SubscriptionCharge> {
    const { rows } = await getPool().query<ChargeRow>(
      `UPDATE subscription_charges SET attempt_count = attempt_count + 1, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id]
    );
    if (!rows[0]) throw new Error(`Subscription charge not found: ${id}`);
    return mapRow(rows[0]);
  }
}

let store: ChargeStore = new InMemoryChargeStore();

export function setChargeStore(newStore: ChargeStore): void {
  store = newStore;
}

export function resetChargeStore(): void {
  store = new InMemoryChargeStore();
}

export function enablePostgresChargeStore(): void {
  store = new PostgresChargeStore();
  log.info("Subscription charge store switched to PostgreSQL backend");
}

export function getChargeStore(): ChargeStore {
  return store;
}
