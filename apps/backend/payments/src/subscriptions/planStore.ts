/**
 * Subscription plan persistence (Issue #47).
 * Postgres-backed (`subscription_plans` from migration 017) in production;
 * in-memory default for tests/local dev.
 */

import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import { createLogger } from "@delegolabs/utils";
import type { CreateSubscriptionPlanInput, SubscriptionPlan } from "./types.js";

const log = createLogger("payments:subscriptions:plan-store", process.env.LOG_LEVEL ?? "info");

export interface PlanUpdate {
  active?: boolean;
}

export interface PlanStore {
  create(input: CreateSubscriptionPlanInput): Promise<SubscriptionPlan>;
  findById(id: string): Promise<SubscriptionPlan | null>;
  update(id: string, update: PlanUpdate): Promise<SubscriptionPlan>;
}

export class InMemoryPlanStore implements PlanStore {
  private readonly plans = new Map<string, SubscriptionPlan>();

  async create(input: CreateSubscriptionPlanInput): Promise<SubscriptionPlan> {
    const plan: SubscriptionPlan = {
      id: randomUUID(),
      merchantId: input.merchantId,
      name: input.name,
      description: input.description ?? "",
      amount: input.amount,
      currency: input.currency,
      interval: input.interval,
      intervalCount: input.intervalCount ?? 1,
      trialDays: input.trialDays,
      usageBased: input.usageBased ?? false,
      maxAmount: input.maxAmount,
      metadata: input.metadata ?? {},
      active: true,
      createdAt: new Date().toISOString(),
    };
    this.plans.set(plan.id, plan);
    return { ...plan };
  }

  async findById(id: string): Promise<SubscriptionPlan | null> {
    const plan = this.plans.get(id);
    return plan ? { ...plan } : null;
  }

  async update(id: string, update: PlanUpdate): Promise<SubscriptionPlan> {
    const existing = this.plans.get(id);
    if (!existing) throw new Error(`Subscription plan not found: ${id}`);
    const updated = { ...existing, ...update };
    this.plans.set(id, updated);
    return { ...updated };
  }
}

interface PlanRow extends QueryResultRow {
  id: string;
  merchant_id: string;
  name: string;
  description: string;
  amount_stroops: string;
  currency: string;
  interval: SubscriptionPlan["interval"];
  interval_count: number;
  trial_days: number | null;
  usage_based: boolean;
  max_amount_stroops: string | null;
  metadata: Record<string, unknown>;
  active: boolean;
  created_at: Date;
}

function mapRow(row: PlanRow): SubscriptionPlan {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    name: row.name,
    description: row.description,
    amount: row.amount_stroops,
    currency: row.currency,
    interval: row.interval,
    intervalCount: row.interval_count,
    trialDays: row.trial_days ?? undefined,
    usageBased: row.usage_based,
    maxAmount: row.max_amount_stroops ?? undefined,
    metadata: row.metadata,
    active: row.active,
    createdAt: row.created_at.toISOString(),
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

export class PostgresPlanStore implements PlanStore {
  async create(input: CreateSubscriptionPlanInput): Promise<SubscriptionPlan> {
    const { rows } = await getPool().query<PlanRow>(
      `INSERT INTO subscription_plans (
         merchant_id, name, description, amount_stroops, currency, interval,
         interval_count, trial_days, usage_based, max_amount_stroops, metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        input.merchantId,
        input.name,
        input.description ?? "",
        input.amount,
        input.currency,
        input.interval,
        input.intervalCount ?? 1,
        input.trialDays ?? null,
        input.usageBased ?? false,
        input.maxAmount ?? null,
        JSON.stringify(input.metadata ?? {}),
      ]
    );
    log.info("Subscription plan created", { id: rows[0].id, merchantId: input.merchantId });
    return mapRow(rows[0]);
  }

  async findById(id: string): Promise<SubscriptionPlan | null> {
    const { rows } = await getPool().query<PlanRow>(`SELECT * FROM subscription_plans WHERE id = $1`, [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async update(id: string, update: PlanUpdate): Promise<SubscriptionPlan> {
    const { rows } = await getPool().query<PlanRow>(
      `UPDATE subscription_plans SET active = COALESCE($2, active) WHERE id = $1 RETURNING *`,
      [id, update.active ?? null]
    );
    if (!rows[0]) throw new Error(`Subscription plan not found: ${id}`);
    return mapRow(rows[0]);
  }
}

let store: PlanStore = new InMemoryPlanStore();

export function setPlanStore(newStore: PlanStore): void {
  store = newStore;
}

export function resetPlanStore(): void {
  store = new InMemoryPlanStore();
}

export function enablePostgresPlanStore(): void {
  store = new PostgresPlanStore();
  log.info("Subscription plan store switched to PostgreSQL backend");
}

export function getPlanStore(): PlanStore {
  return store;
}
