/**
 * Per-address dispute reputation tracking (Issue #46).
 *
 * Updated when a dispute is initiated and when it resolves, so buyer/seller
 * reputation scoring can factor in dispute frequency and outcomes.
 * Postgres-backed (`user_dispute_reputation` from migration 016) in
 * production; in-memory by default for tests/local dev.
 */

import { Pool } from "pg";
import { createLogger } from "@delegolabs/utils";
import type { ResolutionType } from "./types.js";

const log = createLogger("payments:disputes:reputation", process.env.LOG_LEVEL ?? "info");

export interface DisputeReputationRecord {
  address: string;
  disputesInitiated: number;
  disputesInvolved: number;
  disputesResolvedFavorably: number;
  disputesResolvedUnfavorably: number;
  lastDisputeAt: string | null;
}

/** Outcome of a resolved dispute from one party's perspective. */
export type ResolutionOutcome = "favorable" | "unfavorable" | "neutral";

export interface ReputationStore {
  recordInitiated(address: string): Promise<void>;
  recordInvolved(address: string): Promise<void>;
  recordOutcome(address: string, outcome: ResolutionOutcome): Promise<void>;
  get(address: string): Promise<DisputeReputationRecord | null>;
}

function emptyRecord(address: string): DisputeReputationRecord {
  return {
    address,
    disputesInitiated: 0,
    disputesInvolved: 0,
    disputesResolvedFavorably: 0,
    disputesResolvedUnfavorably: 0,
    lastDisputeAt: null,
  };
}

export class InMemoryReputationStore implements ReputationStore {
  private readonly records = new Map<string, DisputeReputationRecord>();

  private getOrCreate(address: string): DisputeReputationRecord {
    let record = this.records.get(address);
    if (!record) {
      record = emptyRecord(address);
      this.records.set(address, record);
    }
    return record;
  }

  async recordInitiated(address: string): Promise<void> {
    const record = this.getOrCreate(address);
    record.disputesInitiated += 1;
    record.lastDisputeAt = new Date().toISOString();
  }

  async recordInvolved(address: string): Promise<void> {
    const record = this.getOrCreate(address);
    record.disputesInvolved += 1;
    record.lastDisputeAt = new Date().toISOString();
  }

  async recordOutcome(address: string, outcome: ResolutionOutcome): Promise<void> {
    const record = this.getOrCreate(address);
    if (outcome === "favorable") record.disputesResolvedFavorably += 1;
    if (outcome === "unfavorable") record.disputesResolvedUnfavorably += 1;
  }

  async get(address: string): Promise<DisputeReputationRecord | null> {
    const record = this.records.get(address);
    return record ? { ...record } : null;
  }
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

export class PostgresReputationStore implements ReputationStore {
  private async upsert(address: string, column: string): Promise<void> {
    await getPool().query(
      `INSERT INTO user_dispute_reputation (address, ${column}, last_dispute_at)
       VALUES ($1, 1, NOW())
       ON CONFLICT (address) DO UPDATE
       SET ${column} = user_dispute_reputation.${column} + 1,
           last_dispute_at = NOW(),
           updated_at = NOW()`,
      [address]
    );
  }

  async recordInitiated(address: string): Promise<void> {
    await this.upsert(address, "disputes_initiated");
  }

  async recordInvolved(address: string): Promise<void> {
    await this.upsert(address, "disputes_involved");
  }

  async recordOutcome(address: string, outcome: ResolutionOutcome): Promise<void> {
    if (outcome === "neutral") return;
    const column = outcome === "favorable" ? "disputes_resolved_favorably" : "disputes_resolved_unfavorably";
    await getPool().query(
      `INSERT INTO user_dispute_reputation (address, ${column})
       VALUES ($1, 1)
       ON CONFLICT (address) DO UPDATE
       SET ${column} = user_dispute_reputation.${column} + 1,
           updated_at = NOW()`,
      [address]
    );
  }

  async get(address: string): Promise<DisputeReputationRecord | null> {
    const { rows } = await getPool().query<{
      address: string;
      disputes_initiated: number;
      disputes_involved: number;
      disputes_resolved_favorably: number;
      disputes_resolved_unfavorably: number;
      last_dispute_at: Date | null;
    }>(`SELECT * FROM user_dispute_reputation WHERE address = $1`, [address]);
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      address: r.address,
      disputesInitiated: r.disputes_initiated,
      disputesInvolved: r.disputes_involved,
      disputesResolvedFavorably: r.disputes_resolved_favorably,
      disputesResolvedUnfavorably: r.disputes_resolved_unfavorably,
      lastDisputeAt: r.last_dispute_at?.toISOString() ?? null,
    };
  }
}

let store: ReputationStore = new InMemoryReputationStore();

export function setReputationStore(newStore: ReputationStore): void {
  store = newStore;
}

export function resetReputationStore(): void {
  store = new InMemoryReputationStore();
}

export function enablePostgresReputationStore(): void {
  store = new PostgresReputationStore();
  log.info("Reputation store switched to PostgreSQL backend");
}

/**
 * Classifies a resolved dispute's outcome for one party by comparing what
 * they were awarded against what the *other* party received. A party that
 * received strictly more than the other is "favorable" for them.
 */
export function classifyOutcome(
  awardedToParty: string,
  awardedToOther: string
): ResolutionOutcome {
  const mine = BigInt(awardedToParty);
  const other = BigInt(awardedToOther);
  if (mine > other) return "favorable";
  if (mine < other) return "unfavorable";
  return "neutral";
}

/** Updates both parties' reputation once a dispute resolution has executed. */
export async function recordDisputeOutcome(params: {
  buyerAddress: string;
  sellerAddress: string;
  buyerAmount: string;
  sellerAmount: string;
}): Promise<void> {
  const buyerOutcome = classifyOutcome(params.buyerAmount, params.sellerAmount);
  const sellerOutcome = classifyOutcome(params.sellerAmount, params.buyerAmount);
  await Promise.all([
    store.recordOutcome(params.buyerAddress, buyerOutcome),
    store.recordOutcome(params.sellerAddress, sellerOutcome),
  ]);
}

export async function recordDisputeInitiated(address: string): Promise<void> {
  await store.recordInitiated(address);
}

export async function recordDisputeInvolved(address: string): Promise<void> {
  await store.recordInvolved(address);
}

export async function getDisputeReputation(address: string): Promise<DisputeReputationRecord | null> {
  return store.get(address);
}

export type { ResolutionType };
