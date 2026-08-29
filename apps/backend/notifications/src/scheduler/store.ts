/** Notification scheduling store contracts (Issue #365, extended for Issue #59) */

import { Sequelize } from "sequelize";

export type ScheduledNotificationStatus = "pending" | "cancelled" | "dispatched" | "failed";

export interface ScheduledNotification {
  id: string;
  userId: string;
  templateName: string;
  payload: Record<string, unknown>;
  /** ISO-8601 timestamp of the next (or only) run. */
  runAt: string;
  /** Cron expression for recurring notifications; undefined for one-time. */
  cronExpression?: string;
  /**
   * IANA timezone the cron expression is evaluated in (Issue #59). Only meaningful
   * for recurring (cronExpression-bearing) records; one-time records schedule an
   * exact runAt instant and don't need a timezone to reschedule against. Defaults
   * to "UTC" for records created before this field existed.
   */
  timezone?: string;
  /** Recurring notifications stop being rescheduled once runAt would exceed this. */
  endAt?: string;
  /** Recurring notifications stop being rescheduled once runCount reaches this. */
  maxRuns?: number;
  /** Number of times this record has been dispatched. */
  runCount: number;
  status: ScheduledNotificationStatus;
  createdAt: string;
  updatedAt: string;
  lastDispatchedAt?: string;
}

export interface CreateScheduledNotificationInput {
  userId: string;
  templateName: string;
  payload: Record<string, unknown>;
  runAt: string;
  cronExpression?: string;
  timezone?: string;
  endAt?: string;
  maxRuns?: number;
}

/** Aggregate counters for scheduler health monitoring (Issue #59). */
export interface SchedulerMetricsSnapshot {
  scheduled: number;
  dispatched: number;
  failed: number;
  cancelled: number;
  /** Average ms between a record's runAt and when it was actually dispatched, over dispatched records. */
  avgLatencyMs: number;
  /** Soonest-due pending records, for operator visibility into what's coming up next. */
  nextRunTimes: Array<{ id: string; nextRunAt: string }>;
}

/**
 * A due record claimed for dispatch, along with the token needed to release or
 * confirm the claim. Distinguishing this from a plain ScheduledNotification makes
 * it a compile error to call markDispatchedAndReschedule()/releaseClaim() without
 * having gone through claimDue() first.
 */
export interface ClaimedScheduledNotification {
  record: ScheduledNotification;
  /** Opaque token identifying this specific claim; required to release or confirm it. */
  claimToken: string;
}

export interface ScheduledNotificationStore {
  create(input: CreateScheduledNotificationInput): Promise<ScheduledNotification>;
  get(id: string): Promise<ScheduledNotification | null>;
  /** Lists scheduled notifications for a user, most recently created first (Issue #59 CRUD API). */
  listByUser(userId: string, options?: { limit?: number; status?: ScheduledNotificationStatus }): Promise<ScheduledNotification[]>;
  cancel(id: string): Promise<ScheduledNotification | null>;
  /** Returns all pending notifications whose runAt <= asOf. Does not claim them — see claimDue(). */
  findDue(asOf: Date): Promise<ScheduledNotification[]>;
  /**
   * Atomically claims up to `batchSize` pending due records for `asOf`, so multiple
   * scheduler instances polling concurrently never dispatch the same notification twice
   * (Issue #59 — distributed locking). A claim is only granted for a row that is
   * unclaimed or whose previous claim's lease has expired (`claimExpiresAt <= now`),
   * mirroring apps/backend/orchestrator/src/saga's claimExpiresAt lease pattern.
   */
  claimDue(asOf: Date, batchSize: number, claimedBy: string, leaseMs: number): Promise<ClaimedScheduledNotification[]>;
  /** Releases a claim without marking the record dispatched — used when dispatch fails, so another poll can retry it. */
  releaseClaim(id: string, claimToken: string): Promise<void>;
  /** Reschedules a recurring notification's next run and marks it dispatched. Also releases the record's claim. */
  markDispatchedAndReschedule(
    id: string,
    claimToken: string,
    nextRunAt: string | null
  ): Promise<ScheduledNotification | null>;
  /** Marks a record permanently failed (e.g. exceeded maxRetries) and releases its claim. */
  markFailed(id: string, claimToken: string): Promise<ScheduledNotification | null>;
  /** Aggregate counters for scheduler health monitoring (Issue #59). */
  getMetrics(): Promise<SchedulerMetricsSnapshot>;
}

let idCounter = 0;
function generateId(): string {
  idCounter += 1;
  return `sched-${Date.now()}-${idCounter}`;
}

function generateClaimToken(): string {
  idCounter += 1;
  return `claim-${Date.now()}-${idCounter}-${Math.random().toString(36).slice(2)}`;
}

export class InMemoryScheduledNotificationStore implements ScheduledNotificationStore {
  private readonly notifications = new Map<string, ScheduledNotification>();
  /** id -> { token, expiresAt } for records currently claimed by a poller. */
  private readonly claims = new Map<string, { token: string; expiresAt: number }>();

  async create(input: CreateScheduledNotificationInput): Promise<ScheduledNotification> {
    const now = new Date().toISOString();
    const record: ScheduledNotification = {
      id: generateId(),
      userId: input.userId,
      templateName: input.templateName,
      payload: input.payload,
      runAt: input.runAt,
      cronExpression: input.cronExpression,
      timezone: input.timezone,
      endAt: input.endAt,
      maxRuns: input.maxRuns,
      runCount: 0,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.notifications.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<ScheduledNotification | null> {
    return this.notifications.get(id) ?? null;
  }

  async listByUser(
    userId: string,
    options: { limit?: number; status?: ScheduledNotificationStatus } = {}
  ): Promise<ScheduledNotification[]> {
    // Map iteration order is insertion order — reverse first so that among
    // records with an identical createdAt (a real possibility: createdAt has only
    // millisecond resolution, and two records can be created in the same
    // millisecond), the stable sort below keeps the most-recently-inserted one
    // first rather than falling back to oldest-inserted-first.
    let results = [...this.notifications.values()].reverse().filter((n) => n.userId === userId);
    if (options.status) {
      results = results.filter((n) => n.status === options.status);
    }
    results.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return options.limit ? results.slice(0, options.limit) : results;
  }

  async cancel(id: string): Promise<ScheduledNotification | null> {
    const record = this.notifications.get(id);
    if (!record) return null;
    if (record.status === "pending") {
      record.status = "cancelled";
      record.updatedAt = new Date().toISOString();
    }
    return record;
  }

  async findDue(asOf: Date): Promise<ScheduledNotification[]> {
    const asOfMs = asOf.getTime();
    return [...this.notifications.values()].filter(
      (n) => n.status === "pending" && new Date(n.runAt).getTime() <= asOfMs
    );
  }

  private isClaimed(id: string, now: number): boolean {
    const claim = this.claims.get(id);
    return !!claim && claim.expiresAt > now;
  }

  async claimDue(
    asOf: Date,
    batchSize: number,
    _claimedBy: string,
    leaseMs: number
  ): Promise<ClaimedScheduledNotification[]> {
    const now = Date.now();
    const due = await this.findDue(asOf);
    const claimed: ClaimedScheduledNotification[] = [];

    for (const record of due) {
      if (claimed.length >= batchSize) break;
      if (this.isClaimed(record.id, now)) continue;

      const claimToken = generateClaimToken();
      this.claims.set(record.id, { token: claimToken, expiresAt: now + leaseMs });
      claimed.push({ record: { ...record }, claimToken });
    }

    return claimed;
  }

  private assertClaim(id: string, claimToken: string): void {
    const claim = this.claims.get(id);
    if (!claim || claim.token !== claimToken) {
      throw new Error(`No active claim ${claimToken} for scheduled notification ${id}`);
    }
  }

  async releaseClaim(id: string, claimToken: string): Promise<void> {
    this.assertClaim(id, claimToken);
    this.claims.delete(id);
  }

  async markDispatchedAndReschedule(
    id: string,
    claimToken: string,
    nextRunAt: string | null
  ): Promise<ScheduledNotification | null> {
    this.assertClaim(id, claimToken);
    const record = this.notifications.get(id);
    if (!record) return null;

    const now = new Date().toISOString();
    record.lastDispatchedAt = now;
    record.updatedAt = now;
    record.runCount += 1;

    if (nextRunAt) {
      record.runAt = nextRunAt;
      record.status = "pending";
    } else {
      record.status = "dispatched";
    }

    this.claims.delete(id);
    return record;
  }

  async markFailed(id: string, claimToken: string): Promise<ScheduledNotification | null> {
    this.assertClaim(id, claimToken);
    const record = this.notifications.get(id);
    if (!record) return null;

    record.status = "failed";
    record.updatedAt = new Date().toISOString();
    this.claims.delete(id);
    return record;
  }

  async getMetrics(): Promise<SchedulerMetricsSnapshot> {
    const all = [...this.notifications.values()];
    const dispatched = all.filter((n) => n.status === "dispatched" || n.runCount > 0);

    const latencies = dispatched
      .filter((n) => n.lastDispatchedAt)
      .map((n) => new Date(n.lastDispatchedAt!).getTime() - new Date(n.createdAt).getTime())
      .filter((ms) => Number.isFinite(ms) && ms >= 0);
    const avgLatencyMs =
      latencies.length > 0 ? latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length : 0;

    const nextRunTimes = all
      .filter((n) => n.status === "pending")
      .sort((a, b) => new Date(a.runAt).getTime() - new Date(b.runAt).getTime())
      .slice(0, 10)
      .map((n) => ({ id: n.id, nextRunAt: n.runAt }));

    return {
      scheduled: all.filter((n) => n.status === "pending").length,
      dispatched: all.filter((n) => n.status === "dispatched").length,
      failed: all.filter((n) => n.status === "failed").length,
      cancelled: all.filter((n) => n.status === "cancelled").length,
      avgLatencyMs,
      nextRunTimes,
    };
  }

  /** Test helper — clears all records and claims. */
  clear(): void {
    this.notifications.clear();
    this.claims.clear();
  }
}

// --- Postgres-backed store (Issue #59) ---------------------------------------

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego";

let sequelizeInstance: Sequelize | null = null;
function getSequelize(): Sequelize {
  if (!sequelizeInstance) {
    sequelizeInstance = new Sequelize(databaseUrl, {
      dialect: "postgres",
      logging: false,
      pool: { min: 1, max: 5, acquire: 30000, idle: 10000 },
    });
  }
  return sequelizeInstance;
}

interface ScheduledNotificationRow {
  id: string;
  user_id: string;
  template_name: string;
  payload: Record<string, unknown>;
  run_at: Date;
  cron_expression: string | null;
  timezone: string;
  end_at: Date | null;
  status: ScheduledNotificationStatus;
  run_count: number;
  max_runs: number | null;
  last_dispatched_at: Date | null;
  claimed_by: string | null;
  claim_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function rowToRecord(row: ScheduledNotificationRow): ScheduledNotification {
  return {
    id: row.id,
    userId: row.user_id,
    templateName: row.template_name,
    payload: row.payload,
    runAt: row.run_at.toISOString(),
    cronExpression: row.cron_expression ?? undefined,
    timezone: row.timezone,
    endAt: row.end_at ? row.end_at.toISOString() : undefined,
    maxRuns: row.max_runs ?? undefined,
    runCount: row.run_count,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastDispatchedAt: row.last_dispatched_at ? row.last_dispatched_at.toISOString() : undefined,
  };
}

/**
 * Postgres-backed ScheduledNotificationStore (Issue #59), so scheduled notifications
 * survive a scheduler restart instead of living only in process memory. Uses
 * `SELECT ... FOR UPDATE SKIP LOCKED` for claimDue() — the same distributed-locking
 * pattern used by the outbox relay (see tests/integration/src/outbox-relay-dedupe.
 * integration.test.js and Issue #36) — so multiple scheduler instances can poll the
 * same table concurrently without ever dispatching the same notification twice.
 *
 * Backed by `scheduled_notifications` (database/migrations/017_scheduled_notifications.sql).
 */
export class PostgresScheduledNotificationStore implements ScheduledNotificationStore {
  async create(input: CreateScheduledNotificationInput): Promise<ScheduledNotification> {
    const sequelize = getSequelize();
    const [rows] = await sequelize.query(
      `INSERT INTO scheduled_notifications
         (user_id, template_name, payload, run_at, cron_expression, timezone, end_at, max_runs)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      {
        bind: [
          input.userId,
          input.templateName,
          JSON.stringify(input.payload),
          input.runAt,
          input.cronExpression ?? null,
          input.timezone ?? "UTC",
          input.endAt ?? null,
          input.maxRuns ?? null,
        ],
      }
    );
    return rowToRecord((rows as ScheduledNotificationRow[])[0]);
  }

  async get(id: string): Promise<ScheduledNotification | null> {
    const sequelize = getSequelize();
    const [rows] = await sequelize.query(`SELECT * FROM scheduled_notifications WHERE id = $1`, {
      bind: [id],
    });
    const row = (rows as ScheduledNotificationRow[])[0];
    return row ? rowToRecord(row) : null;
  }

  async listByUser(
    userId: string,
    options: { limit?: number; status?: ScheduledNotificationStatus } = {}
  ): Promise<ScheduledNotification[]> {
    const sequelize = getSequelize();
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    // ORDER BY created_at DESC, id DESC — id is a secondary tiebreaker for records
    // created in the same instant (concurrent inserts), so the ordering is
    // deterministic instead of depending on incidental physical row order.
    const [rows] = options.status
      ? await sequelize.query(
          `SELECT * FROM scheduled_notifications
            WHERE user_id = $1 AND status = $2
            ORDER BY created_at DESC, id DESC LIMIT $3`,
          { bind: [userId, options.status, limit] }
        )
      : await sequelize.query(
          `SELECT * FROM scheduled_notifications
            WHERE user_id = $1
            ORDER BY created_at DESC, id DESC LIMIT $2`,
          { bind: [userId, limit] }
        );
    return (rows as ScheduledNotificationRow[]).map(rowToRecord);
  }

  async cancel(id: string): Promise<ScheduledNotification | null> {
    const sequelize = getSequelize();
    const [rows] = await sequelize.query(
      `UPDATE scheduled_notifications
          SET status = 'cancelled', updated_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING *`,
      { bind: [id] }
    );
    const updated = (rows as ScheduledNotificationRow[])[0];
    if (updated) return rowToRecord(updated);
    // Already not pending (or missing) — return current state rather than null-on-noop,
    // matching InMemoryScheduledNotificationStore's "return current record either way".
    return this.get(id);
  }

  async findDue(asOf: Date): Promise<ScheduledNotification[]> {
    const sequelize = getSequelize();
    const [rows] = await sequelize.query(
      `SELECT * FROM scheduled_notifications WHERE status = 'pending' AND run_at <= $1`,
      { bind: [asOf.toISOString()] }
    );
    return (rows as ScheduledNotificationRow[]).map(rowToRecord);
  }

  async claimDue(
    asOf: Date,
    batchSize: number,
    claimedBy: string,
    leaseMs: number
  ): Promise<ClaimedScheduledNotification[]> {
    const sequelize = getSequelize();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();

    const [rows] = await sequelize.query(
      `UPDATE scheduled_notifications
          SET claimed_by = $1, claim_expires_at = $2, updated_at = now()
        WHERE id IN (
          SELECT id FROM scheduled_notifications
           WHERE status = 'pending'
             AND run_at <= $3
             AND (claim_expires_at IS NULL OR claim_expires_at <= now())
           ORDER BY run_at
           LIMIT $4
           FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      { bind: [claimedBy, leaseExpiresAt, asOf.toISOString(), batchSize] }
    );

    return (rows as ScheduledNotificationRow[]).map((row) => ({
      record: rowToRecord(row),
      // The claim token is the lease expiry itself — unique enough per claim attempt
      // (millisecond resolution) and lets releaseClaim()/markDispatchedAndReschedule()
      // verify they're operating on the same claim they were handed, without a
      // separate token column.
      claimToken: leaseExpiresAt,
    }));
  }

  private async assertClaimed(id: string, claimToken: string): Promise<void> {
    const sequelize = getSequelize();
    const [rows] = await sequelize.query(
      `SELECT 1 FROM scheduled_notifications
        WHERE id = $1 AND claim_expires_at = $2 AND claim_expires_at > now()`,
      { bind: [id, claimToken] }
    );
    if ((rows as unknown[]).length === 0) {
      throw new Error(`No active claim ${claimToken} for scheduled notification ${id}`);
    }
  }

  async releaseClaim(id: string, claimToken: string): Promise<void> {
    await this.assertClaimed(id, claimToken);
    const sequelize = getSequelize();
    await sequelize.query(
      `UPDATE scheduled_notifications
          SET claimed_by = NULL, claim_expires_at = NULL, updated_at = now()
        WHERE id = $1`,
      { bind: [id] }
    );
  }

  async markDispatchedAndReschedule(
    id: string,
    claimToken: string,
    nextRunAt: string | null
  ): Promise<ScheduledNotification | null> {
    await this.assertClaimed(id, claimToken);
    const sequelize = getSequelize();

    const [rows] = nextRunAt
      ? await sequelize.query(
          `UPDATE scheduled_notifications
              SET status = 'pending', run_at = $2, run_count = run_count + 1,
                  last_dispatched_at = now(), claimed_by = NULL, claim_expires_at = NULL,
                  updated_at = now()
            WHERE id = $1
            RETURNING *`,
          { bind: [id, nextRunAt] }
        )
      : await sequelize.query(
          `UPDATE scheduled_notifications
              SET status = 'dispatched', run_count = run_count + 1,
                  last_dispatched_at = now(), claimed_by = NULL, claim_expires_at = NULL,
                  updated_at = now()
            WHERE id = $1
            RETURNING *`,
          { bind: [id] }
        );

    const row = (rows as ScheduledNotificationRow[])[0];
    return row ? rowToRecord(row) : null;
  }

  async markFailed(id: string, claimToken: string): Promise<ScheduledNotification | null> {
    await this.assertClaimed(id, claimToken);
    const sequelize = getSequelize();
    const [rows] = await sequelize.query(
      `UPDATE scheduled_notifications
          SET status = 'failed', claimed_by = NULL, claim_expires_at = NULL, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      { bind: [id] }
    );
    const row = (rows as ScheduledNotificationRow[])[0];
    return row ? rowToRecord(row) : null;
  }

  async getMetrics(): Promise<SchedulerMetricsSnapshot> {
    const sequelize = getSequelize();
    const [statusCountRows] = await sequelize.query(
      `SELECT status, count(*)::int AS count FROM scheduled_notifications GROUP BY status`
    );
    const counts = Object.fromEntries(
      (statusCountRows as Array<{ status: string; count: number }>).map((r) => [r.status, r.count])
    );

    const [latencyRows] = await sequelize.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (last_dispatched_at - created_at)) * 1000)::float AS avg_ms
         FROM scheduled_notifications
        WHERE last_dispatched_at IS NOT NULL`
    );
    const avgLatencyMs = (latencyRows as Array<{ avg_ms: number | null }>)[0]?.avg_ms ?? 0;

    const [nextRunRows] = await sequelize.query(
      `SELECT id, run_at FROM scheduled_notifications
        WHERE status = 'pending'
        ORDER BY run_at ASC
        LIMIT 10`
    );

    return {
      scheduled: counts.pending ?? 0,
      dispatched: counts.dispatched ?? 0,
      failed: counts.failed ?? 0,
      cancelled: counts.cancelled ?? 0,
      avgLatencyMs: avgLatencyMs ?? 0,
      nextRunTimes: (nextRunRows as Array<{ id: string; run_at: Date }>).map((r) => ({
        id: r.id,
        nextRunAt: r.run_at.toISOString(),
      })),
    };
  }
}
