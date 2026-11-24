/**
 * Anti-Sybil Score Calculator (Issue #anti-sybil)
 *
 * Discounts reviews from newly-created Stellar accounts or escrow
 * transactions below economic thresholds. Malicious actors can
 * wash-trade negligible 1-stroop transactions to artificially boost
 * merchant reputation; this service assigns a trustWeight < 0.2 in
 * those cases and flags repeat reciprocal transactions between the
 * same buyer/merchant pair.
 */

import { createRequire } from "node:module";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("payments:sybil", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum account age (in days) to receive full trust. */
const MIN_ACCOUNT_AGE_DAYS = 7;

/** Minimum escrow volume in USDC to receive full trust. */
const MIN_ESCROW_VOLUME_USDC = 1;

/** Stroops per XLM (Stellar's base unit). */
const STROOPS_PER_XLM = 10_000_000;

/**
 * 1 USDC ≈ 1 USD. We use a fixed exchange rate here; in production
 * this should be read from the exchange-rate oracle.
 */
const USDC_PER_XLM = 0.1;

/** Penalty weight applied to suspicious accounts. */
const SUSPICIOUS_TRUST_WEIGHT = 0.1;

/** Full trust weight for verified accounts. */
const FULL_TRUST_WEIGHT = 1.0;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SybilEvaluationResult {
  isSuspicious: boolean;
  /** 0.0 to 1.0 — weight applied when computing weighted-average ratings. */
  trustWeight: number;
  reasons: string[];
  accountAgeDays: number;
  escrowVolumeUsdc: number;
}

/** Minimal Stellar account info needed for sybil evaluation. */
export interface StellarAccountInfo {
  /** ISO-8601 creation timestamp of the Stellar account. */
  createdAt: string;
  /** Total escrow / payment amount transacted (in stroops). */
  totalTransactionStroops: string;
}

// ---------------------------------------------------------------------------
// Reciprocal-transaction tracking (Redis / Postgres / in-memory with TTL)
// ---------------------------------------------------------------------------

/** Default sliding/TTL window for reciprocal transaction detection (24 hours). */
export const DEFAULT_RECIPROCAL_WINDOW_MS = 24 * 60 * 60 * 1_000;

const RECIPROCAL_KEY_PREFIX = "sybil:reciprocal";
const SAFE_SQL_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Tracks (buyer, merchant) pairs and their transaction counts within a TTL
 * window so we can flag wash-trading between the same two addresses across
 * requests and payment replicas.
 */
export interface ReciprocalTransactionStore {
  record(buyerAddress: string, merchantAddress: string, ttlMs?: number): Promise<void>;
  getCount(buyerAddress: string, merchantAddress: string): Promise<number>;
  reset(): void | Promise<void>;
}

function pairKey(buyer: string, merchant: string): string {
  return `${buyer}::${merchant}`;
}

export class InMemoryReciprocalStore implements ReciprocalTransactionStore {
  private readonly entries = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number = DEFAULT_RECIPROCAL_WINDOW_MS,
    private readonly nowFn: () => number = Date.now
  ) {}

  private prune(key: string, now: number): number[] {
    const existing = this.entries.get(key);
    if (!existing) return [];
    const active = existing.filter((expiresAt) => expiresAt > now);
    if (active.length === 0) {
      this.entries.delete(key);
    } else if (active.length !== existing.length) {
      this.entries.set(key, active);
    }
    return active;
  }

  async record(buyerAddress: string, merchantAddress: string, ttlMs?: number): Promise<void> {
    const key = pairKey(buyerAddress, merchantAddress);
    const now = this.nowFn();
    const active = this.prune(key, now);
    active.push(now + (ttlMs ?? this.windowMs));
    this.entries.set(key, active);
  }

  async getCount(buyerAddress: string, merchantAddress: string): Promise<number> {
    return this.prune(pairKey(buyerAddress, merchantAddress), this.nowFn()).length;
  }

  reset(): void {
    this.entries.clear();
  }
}

/** Minimal subset of the ioredis client API required by RedisReciprocalStore. */
export interface ReciprocalRedisClient {
  incr(key: string): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<number>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

export interface RedisReciprocalStoreOptions {
  windowMs?: number;
  keyPrefix?: string;
}

/**
 * Redis-backed reciprocal-transaction store with key-level TTL windowing.
 * Shares state across payment replicas and survives process restarts.
 */
export class RedisReciprocalStore implements ReciprocalTransactionStore {
  private readonly windowMs: number;
  private readonly keyPrefix: string;
  private readonly trackedKeys = new Set<string>();

  constructor(
    private readonly redis: ReciprocalRedisClient,
    options: RedisReciprocalStoreOptions = {}
  ) {
    this.windowMs = options.windowMs ?? DEFAULT_RECIPROCAL_WINDOW_MS;
    this.keyPrefix = options.keyPrefix ?? RECIPROCAL_KEY_PREFIX;
  }

  private redisKey(buyerAddress: string, merchantAddress: string): string {
    return `${this.keyPrefix}:${pairKey(buyerAddress, merchantAddress)}`;
  }

  async record(buyerAddress: string, merchantAddress: string, ttlMs?: number): Promise<void> {
    const key = this.redisKey(buyerAddress, merchantAddress);
    const count = await this.redis.incr(key);
    if (count === 1 || ttlMs !== undefined) {
      await this.redis.pexpire(key, ttlMs ?? this.windowMs);
    }
    this.trackedKeys.add(key);
  }

  async getCount(buyerAddress: string, merchantAddress: string): Promise<number> {
    const raw = await this.redis.get(this.redisKey(buyerAddress, merchantAddress));
    if (raw === null) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  async reset(): Promise<void> {
    if (this.trackedKeys.size > 0) {
      await this.redis.del(...this.trackedKeys);
      this.trackedKeys.clear();
    }
  }
}

/** Minimal subset of pg.Pool required by PostgresReciprocalStore. */
export interface ReciprocalPgPool {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[]
  ): Promise<{ rows: T[] }>;
}

export interface PostgresReciprocalStoreOptions {
  windowMs?: number;
  tableName?: string;
  nowFn?: () => number;
}

/**
 * Postgres-backed reciprocal-transaction store with row-level TTL windowing.
 * Shares state across payment replicas and survives process restarts.
 */
export class PostgresReciprocalStore implements ReciprocalTransactionStore {
  private readonly windowMs: number;
  private readonly tableName: string;
  private readonly nowFn: () => number;

  constructor(
    private readonly pool: ReciprocalPgPool,
    options: PostgresReciprocalStoreOptions = {}
  ) {
    this.windowMs = options.windowMs ?? DEFAULT_RECIPROCAL_WINDOW_MS;
    this.tableName = options.tableName ?? "sybil_reciprocal_transactions";
    if (!SAFE_SQL_IDENTIFIER.test(this.tableName)) {
      throw new Error(`Invalid SQL table name: ${this.tableName}`);
    }
    this.nowFn = options.nowFn ?? Date.now;
  }

  async record(buyerAddress: string, merchantAddress: string, ttlMs?: number): Promise<void> {
    const nowMs = this.nowFn();
    const recordedAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + (ttlMs ?? this.windowMs)).toISOString();
    await this.pool.query(
      `INSERT INTO ${this.tableName} (buyer_address, merchant_address, recorded_at, expires_at) VALUES ($1, $2, $3, $4)`,
      [buyerAddress, merchantAddress, recordedAt, expiresAt]
    );
  }

  async getCount(buyerAddress: string, merchantAddress: string): Promise<number> {
    const nowIso = new Date(this.nowFn()).toISOString();
    const { rows } = await this.pool.query<{ count: string | number }>(
      `SELECT COUNT(*)::int AS count FROM ${this.tableName} WHERE buyer_address = $1 AND merchant_address = $2 AND expires_at > $3`,
      [buyerAddress, merchantAddress, nowIso]
    );
    const raw = rows[0]?.count ?? 0;
    const parsed = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  async reset(): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.tableName}`);
  }
}

let reciprocalStore: ReciprocalTransactionStore | null = null;

function createDefaultReciprocalStore(): ReciprocalTransactionStore {
  const isTest = process.env.NODE_ENV === "test";
  const useMemory = isTest || process.env.MOCK_REDIS === "true" || process.env.CI === "true";

  if (!useMemory && process.env.REDIS_URL) {
    try {
      const _require = createRequire(import.meta.url);
      const { Redis } = _require("ioredis") as {
        Redis: new (url: string) => ReciprocalRedisClient;
      };
      return new RedisReciprocalStore(new Redis(process.env.REDIS_URL));
    } catch {
      log.warn("ioredis unavailable — falling back to in-memory reciprocal store");
    }
  }
  return new InMemoryReciprocalStore();
}

export function getReciprocalStore(): ReciprocalTransactionStore {
  if (!reciprocalStore) {
    reciprocalStore = createDefaultReciprocalStore();
  }
  return reciprocalStore;
}

export function setReciprocalStore(store: ReciprocalTransactionStore): void {
  reciprocalStore = store;
}

export function resetReciprocalStore(): void {
  reciprocalStore = new InMemoryReciprocalStore();
}

// ---------------------------------------------------------------------------
// Horizon account fetching
// ---------------------------------------------------------------------------

/** Fetches minimal account data from the Stellar Horizon API. */
export async function fetchStellarAccountInfo(
  stellarAddress: string,
  horizonBaseUrl = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org"
): Promise<StellarAccountInfo | null> {
  try {
    const url = `${horizonBaseUrl}/accounts/${encodeURIComponent(stellarAddress)}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      log.warn("Horizon account fetch failed", { stellarAddress, status: res.status });
      return null;
    }
    const data = (await res.json()) as {
      id: string;
      created_at?: string;
      last_modified_time?: string;
      balances?: Array<{ balance: string; asset_type: string }>;
    };

    const createdAt = data.created_at ?? data.last_modified_time ?? new Date().toISOString();
    // Sum up all native (XLM) balance as a proxy for transaction volume.
    const xlmBalance = data.balances?.find((b) => b.asset_type === "native")?.balance ?? "0";
    const totalStroops = BigInt(Math.round(parseFloat(xlmBalance) * STROOPS_PER_XLM)).toString();

    return { createdAt, totalTransactionStroops: totalStroops };
  } catch (err) {
    log.error("fetchStellarAccountInfo failed", {
      stellarAddress,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core evaluation logic
// ---------------------------------------------------------------------------

/**
 * Converts a stroop amount to an approximate USDC value.
 * stroops → XLM → USDC (using a fixed rate).
 */
function stroopsToUsdc(stroops: string): number {
  const xlm = Number(BigInt(stroops)) / STROOPS_PER_XLM;
  return xlm * USDC_PER_XLM;
}

/**
 * Computes the account age in days from the Stellar `created_at` timestamp.
 */
function accountAgeDays(createdAtIso: string): number {
  const createdMs = new Date(createdAtIso).getTime();
  const nowMs = Date.now();
  return (nowMs - createdMs) / (1_000 * 60 * 60 * 24);
}

/**
 * Evaluates a buyer's Sybil risk and returns a trust weight in [0, 1].
 *
 * @param buyerAddress    Stellar address of the buyer leaving the review.
 * @param merchantAddress Stellar address of the merchant being reviewed.
 * @param escrowStroops   Amount (in stroops) of the escrow transaction.
 * @param accountInfo     Optional pre-fetched account info (skips Horizon call).
 */
export async function evaluateSybilRisk(
  buyerAddress: string,
  merchantAddress: string,
  escrowStroops: string,
  accountInfo?: StellarAccountInfo | null
): Promise<SybilEvaluationResult> {
  const reasons: string[] = [];

  // Fetch Stellar account data if not already provided.
  const info = accountInfo ?? (await fetchStellarAccountInfo(buyerAddress));
  const ageDays = info ? accountAgeDays(info.createdAt) : 0;
  const escrowVolumeUsdc = stroopsToUsdc(escrowStroops);

  let isSuspicious = false;

  if (ageDays < MIN_ACCOUNT_AGE_DAYS) {
    isSuspicious = true;
    reasons.push(`Account is only ${ageDays.toFixed(1)} days old (minimum: ${MIN_ACCOUNT_AGE_DAYS})`);
  }

  if (escrowVolumeUsdc < MIN_ESCROW_VOLUME_USDC) {
    isSuspicious = true;
    reasons.push(
      `Escrow volume $${escrowVolumeUsdc.toFixed(6)} USDC is below the minimum $${MIN_ESCROW_VOLUME_USDC} USDC`
    );
  }

  // Check for reciprocal wash-trading between this exact (buyer, merchant) pair.
  const store = getReciprocalStore();
  const reciprocalCount = await store.getCount(buyerAddress, merchantAddress);
  if (reciprocalCount > 0) {
    isSuspicious = true;
    reasons.push(
      `Repeat reciprocal transaction detected between buyer and merchant (count: ${reciprocalCount + 1})`
    );
  }

  // Record this transaction for future checks.
  await store.record(buyerAddress, merchantAddress);

  const trustWeight = isSuspicious ? SUSPICIOUS_TRUST_WEIGHT : FULL_TRUST_WEIGHT;

  log.info("Sybil evaluation complete", {
    buyerAddress,
    merchantAddress,
    isSuspicious,
    trustWeight,
    ageDays,
    escrowVolumeUsdc,
    reasons,
  });

  return {
    isSuspicious,
    trustWeight,
    reasons,
    accountAgeDays: ageDays,
    escrowVolumeUsdc,
  };
}

// ---------------------------------------------------------------------------
// Weighted average rating calculator
// ---------------------------------------------------------------------------

export interface WeightedRatingInput {
  rating: number; // 1-5
  trustWeight: number; // 0.0-1.0
}

/**
 * Computes a trust-weighted average rating from a set of review inputs.
 * Reviews with a low trust weight (sybil suspects) contribute proportionally
 * less to the final score.
 *
 * Returns `null` if the total weight sums to zero (no valid reviews).
 */
export function computeWeightedAverageRating(reviews: WeightedRatingInput[]): number | null {
  if (reviews.length === 0) return null;

  let weightedSum = 0;
  let totalWeight = 0;

  for (const { rating, trustWeight } of reviews) {
    weightedSum += rating * trustWeight;
    totalWeight += trustWeight;
  }

  if (totalWeight === 0) return null;

  return weightedSum / totalWeight;
}
