/**
 * Subscription persistence (Issue #47).
 * Postgres-backed (`subscriptions` from migration 017) in production;
 * in-memory default for tests/local dev.
 */

import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import { createLogger } from "@delegolabs/utils";
import type { CreateSubscriptionInput, Subscription, SubscriptionStatus } from "./types.js";

const log = createLogger("payments:subscriptions:store", process.env.LOG_LEVEL ?? "info");

export interface CreateSubscriptionRecordInput extends CreateSubscriptionInput {
  status: SubscriptionStatus;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEnd?: string;
}

export interface SubscriptionUpdate {
  planId?: string;
  status?: SubscriptionStatus;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  trialEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  metadata?: Record<string, unknown>;
}

export interface SubscriptionStore {
  create(input: CreateSubscriptionRecordInput): Promise<Subscription>;
  findById(id: string): Promise<Subscription | null>;
  update(id: string, update: SubscriptionUpdate): Promise<Subscription>;
  /** Subscriptions whose current period has ended (due for renewal or trial conversion). */
  findDue(now: Date, statuses: SubscriptionStatus[]): Promise<Subscription[]>;
  /** Subscriptions flagged to cancel at period end, whose period has now ended. */
  findPendingCancellation(now: Date): Promise<Subscription[]>;
}

export class InMemorySubscriptionStore implements SubscriptionStore {
  private readonly subscriptions = new Map<string, Subscription>();

  async create(input: CreateSubscriptionRecordInput): Promise<Subscription> {
    const now = new Date().toISOString();
    const subscription: Subscription = {
      id: randomUUID(),
      planId: input.planId,
      buyerAddress: input.buyerAddress,
      sellerAddress: input.sellerAddress,
      status: input.status,
      currentPeriodStart: input.currentPeriodStart,
      currentPeriodEnd: input.currentPeriodEnd,
      trialEnd: input.trialEnd,
      cancelAtPeriodEnd: false,
      paymentMethod: input.paymentMethod,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.subscriptions.set(subscription.id, subscription);
    return { ...subscription };
  }

  async findById(id: string): Promise<Subscription | null> {
    const sub = this.subscriptions.get(id);
    return sub ? { ...sub } : null;
  }

  async update(id: string, update: SubscriptionUpdate): Promise<Subscription> {
    const existing = this.subscriptions.get(id);
    if (!existing) throw new Error(`Subscription not found: ${id}`);

    const updated: Subscription = {
      ...existing,
      planId: update.planId ?? existing.planId,
      status: update.status ?? existing.status,
      currentPeriodStart: update.currentPeriodStart ?? existing.currentPeriodStart,
      currentPeriodEnd: update.currentPeriodEnd ?? existing.currentPeriodEnd,
      trialEnd: update.trialEnd === null ? undefined : (update.trialEnd ?? existing.trialEnd),
      cancelAtPeriodEnd: update.cancelAtPeriodEnd ?? existing.cancelAtPeriodEnd,
      metadata: update.metadata ?? existing.metadata,
      updatedAt: new Date().toISOString(),
    };
    this.subscriptions.set(id, updated);
    return { ...updated };
  }

  async findDue(now: Date, statuses: SubscriptionStatus[]): Promise<Subscription[]> {
    return Array.from(this.subscriptions.values())
      .filter((s) => statuses.includes(s.status) && new Date(s.currentPeriodEnd).getTime() <= now.getTime())
      .map((s) => ({ ...s }));
  }

  async findPendingCancellation(now: Date): Promise<Subscription[]> {
    return Array.from(this.subscriptions.values())
      .filter(
        (s) =>
          s.cancelAtPeriodEnd &&
          s.status !== "cancelled" &&
          new Date(s.currentPeriodEnd).getTime() <= now.getTime()
      )
      .map((s) => ({ ...s }));
  }
}

interface SubscriptionRow extends QueryResultRow {
  id: string;
  plan_id: string;
  buyer_address: string;
  seller_address: string;
  status: SubscriptionStatus;
  current_period_start: Date;
  current_period_end: Date;
  trial_end: Date | null;
  cancel_at_period_end: boolean;
  payment_method_type: "escrow" | "wallet";
  escrow_contract_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    planId: row.plan_id,
    buyerAddress: row.buyer_address,
    sellerAddress: row.seller_address,
    status: row.status,
    currentPeriodStart: row.current_period_start.toISOString(),
    currentPeriodEnd: row.current_period_end.toISOString(),
    trialEnd: row.trial_end?.toISOString(),
    cancelAtPeriodEnd: row.cancel_at_period_end,
    paymentMethod: { type: row.payment_method_type, escrowContractId: row.escrow_contract_id ?? undefined },
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
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

export class PostgresSubscriptionStore implements SubscriptionStore {
  async create(input: CreateSubscriptionRecordInput): Promise<Subscription> {
    const { rows } = await getPool().query<SubscriptionRow>(
      `INSERT INTO subscriptions (
         plan_id, buyer_address, seller_address, status, current_period_start,
         current_period_end, trial_end, payment_method_type, escrow_contract_id, metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        input.planId,
        input.buyerAddress,
        input.sellerAddress,
        input.status,
        input.currentPeriodStart,
        input.currentPeriodEnd,
        input.trialEnd ?? null,
        input.paymentMethod.type,
        input.paymentMethod.escrowContractId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ]
    );
    log.info("Subscription created", { id: rows[0].id, planId: input.planId });
    return mapRow(rows[0]);
  }

  async findById(id: string): Promise<Subscription | null> {
    const { rows } = await getPool().query<SubscriptionRow>(`SELECT * FROM subscriptions WHERE id = $1`, [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async update(id: string, update: SubscriptionUpdate): Promise<Subscription> {
    const fields: string[] = [];
    const values: unknown[] = [id];
    const addField = (column: string, value: unknown) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };

    if (update.planId !== undefined) addField("plan_id", update.planId);
    if (update.status !== undefined) addField("status", update.status);
    if (update.currentPeriodStart !== undefined) addField("current_period_start", update.currentPeriodStart);
    if (update.currentPeriodEnd !== undefined) addField("current_period_end", update.currentPeriodEnd);
    if (update.trialEnd !== undefined) addField("trial_end", update.trialEnd);
    if (update.cancelAtPeriodEnd !== undefined) addField("cancel_at_period_end", update.cancelAtPeriodEnd);
    if (update.metadata !== undefined) addField("metadata", JSON.stringify(update.metadata));

    if (fields.length === 0) {
      const { rows } = await getPool().query<SubscriptionRow>(`SELECT * FROM subscriptions WHERE id = $1`, [id]);
      if (!rows[0]) throw new Error(`Subscription not found: ${id}`);
      return mapRow(rows[0]);
    }

    fields.push("updated_at = NOW()");
    const { rows } = await getPool().query<SubscriptionRow>(
      `UPDATE subscriptions SET ${fields.join(", ")} WHERE id = $1 RETURNING *`,
      values
    );
    if (!rows[0]) throw new Error(`Subscription not found: ${id}`);
    return mapRow(rows[0]);
  }

  async findDue(now: Date, statuses: SubscriptionStatus[]): Promise<Subscription[]> {
    const { rows } = await getPool().query<SubscriptionRow>(
      `SELECT * FROM subscriptions WHERE status = ANY($1) AND current_period_end <= $2`,
      [statuses, now]
    );
    return rows.map(mapRow);
  }

  async findPendingCancellation(now: Date): Promise<Subscription[]> {
    const { rows } = await getPool().query<SubscriptionRow>(
      `SELECT * FROM subscriptions
       WHERE cancel_at_period_end = true AND status != 'cancelled' AND current_period_end <= $1`,
      [now]
    );
    return rows.map(mapRow);
  }
}

let store: SubscriptionStore = new InMemorySubscriptionStore();

export function setSubscriptionStore(newStore: SubscriptionStore): void {
  store = newStore;
}

export function resetSubscriptionStore(): void {
  store = new InMemorySubscriptionStore();
}

export function enablePostgresSubscriptionStore(): void {
  store = new PostgresSubscriptionStore();
  log.info("Subscription store switched to PostgreSQL backend");
}

export function getSubscriptionStore(): SubscriptionStore {
  return store;
}
