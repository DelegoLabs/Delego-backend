import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MIGRATE_SCRIPT = path.join(REPO_ROOT, "scripts", "setup", "migrate.js");
const BASE_DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego";

const adminUrl = new URL(BASE_DATABASE_URL);
adminUrl.pathname = "/postgres";
const ADMIN_URL = adminUrl.toString();

async function serverReachable() {
  const client = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

const dbAvailable = await serverReachable();
if (!dbAvailable) {
  console.log(
    `[tests] Skipping time-series partitioning tests — no PostgreSQL at ${ADMIN_URL} (start it with 'docker compose up -d postgres')`,
  );
}

const suite = dbAvailable ? describe : describe.skip;
let dbCounter = 0;

async function createDisposableDatabase(t) {
  const dbName = `delego_ts_test_${process.pid}_${Date.now()}_${dbCounter++}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(BASE_DATABASE_URL);
  url.pathname = `/${dbName}`;
  t.after(async () => {
    const cleanup = new pg.Client({ connectionString: ADMIN_URL });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  });
  return url.toString();
}

function runMigrate(databaseUrl) {
  return spawnSync(process.execPath, [MIGRATE_SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

async function query(databaseUrl, sql, values = []) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await client.query(sql, values);
  } finally {
    await client.end();
  }
}

suite("time-series partitioning & retention", () => {
  before(async () => {
    assert.ok(fs.existsSync(MIGRATE_SCRIPT), "migration runner is missing");
  });

  it("creates partitioned time-series tables and seeds config", async (t) => {
    const db = await createDisposableDatabase(t);
    const run = runMigrate(db);
    assert.equal(run.status, 0, `migrate failed:\n${run.stderr}`);

    // Tables are declaratively partitioned by range on the ts column.
    const partitioned = await query(
      db,
      `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'p' AND c.relname IN ('ts_metrics','ts_events','ts_audit_events')`,
    );
    assert.equal(partitioned.rows.length, 3, "expected three range-partitioned tables");

    // Config tables are seeded with the three canonical streams.
    const cfg = await query(db, "SELECT table_name FROM time_series_table_config ORDER BY table_name");
    assert.deepEqual(
      cfg.rows.map((r) => r.table_name),
      ["ts_audit_events", "ts_events", "ts_metrics"],
    );

    const agg = await query(db, "SELECT view_name FROM continuous_aggregate_config ORDER BY view_name");
    assert.deepEqual(agg.rows.map((r) => r.view_name), ["ts_events_daily", "ts_metrics_hourly"]);

    const tiering = await query(db, "SELECT table_name FROM data_tiering_policy ORDER BY table_name");
    assert.equal(tiering.rows.length, 3);
  });

  it("auto-creates look-ahead partitions and registers them", async (t) => {
    const db = await createDisposableDatabase(t);
    assert.equal(runMigrate(db).status, 0);

    const before = await query(db, "SELECT count(*)::int AS n FROM ts_list_partitions('ts_events')");
    const created = await query(db, "SELECT ts_create_partitions_for_table('ts_events', 3) AS n");
    assert.ok(created.rows[0].n > 0, "expected at least one new partition to be created");
    const after = await query(db, "SELECT count(*)::int AS n FROM ts_list_partitions('ts_events')");
    assert.ok(after.rows[0].n > before.rows[0].n);
  });

  it("enforces retention by dropping expired partitions", async (t) => {
    const db = await createDisposableDatabase(t);
    assert.equal(runMigrate(db).status, 0);

    // Backfill a partition that is well outside the retention window so there
    // is something old enough to drop.
    const backfilled = await query(
      db,
      "SELECT ts_backfill_partition('ts_events', NOW() - INTERVAL '100 days', NOW() - INTERVAL '99 days') AS p",
    );
    assert.ok(backfilled.rows[0].p, "historical partition should be backfilled");

    // Force a short retention window so today's partitions are not affected but
    // the 99-days-old partition definitely is.
    await query(
      db,
      "UPDATE time_series_table_config SET retention_interval = '30 days' WHERE table_name = 'ts_events'",
    );
    const dropped = await query(db, "SELECT * FROM ts_apply_retention() WHERE table_name='ts_events'");
    assert.ok(dropped.rows[0]?.partitions_dropped >= 1, "retention should drop the expired partition");

    // Registry and physical table agree (no references to dropped partitions).
    const orphaned = await query(
      db,
      `SELECT count(*)::int AS n FROM ts_parts p
       LEFT JOIN pg_class c ON c.relname = p.partition_name
       WHERE p.table_name='ts_events' AND c.oid IS NULL`,
    );
    assert.equal(orphaned.rows[0].n, 0, "registry must not reference dropped partitions");
  });

  it("runs time-range queries fast and refreshes continuous aggregates", async (t) => {
    const db = await createDisposableDatabase(t);
    assert.equal(runMigrate(db).status, 0);

    // Insert a burst of rows spanning the seeded partitions.
    const now = Date.now();
    const rows = [];
    for (let i = 0; i < 500; i++) {
      rows.push([new Date(now + (i % 2) * 86_400_000).toISOString(), `et_${i % 5}`, `e_${i}`, {}]);
    }
    for (const [ts, et, eid, payload] of rows) {
      await query(db, "INSERT INTO ts_events (ts,event_type,entity_id,payload) VALUES ($1,$2,$3,$4)", [
        ts,
        et,
        eid,
        payload,
      ]);
    }

    // Continuous aggregate refresh populates ts_events_daily.
    await query(db, "SELECT ts_refresh_continuous_aggregates()");
    const daily = await query(db, "SELECT count(*)::int AS n FROM ts_events_daily");
    assert.ok(daily.rows[0].n >= 1, "aggregate should contain bucketed rows");

    // Benchmark bounded range-query latency.
    const bench = await query(
      db,
      "SELECT * FROM ts_benchmark_time_range('ts_events', NOW() - INTERVAL '1 hour', NOW() + INTERVAL '2 days')",
    );
    assert.equal(bench.rows.length, 1);
    assert.ok(
      bench.rows[0].execution_ms < 50,
      `time-range query expected < 50ms but got ${bench.rows[0].execution_ms}ms`,
    );
    assert.ok(bench.rows[0].partitions_in_window >= 1);
  });

  it("applies hot/warm/cold tiering classification", async (t) => {
    const db = await createDisposableDatabase(t);
    assert.equal(runMigrate(db).status, 0);

    const plan = await query(db, "SELECT * FROM ts_apply_tiering() WHERE table_name='ts_events'");
    assert.ok(plan.rows.length >= 1, "tiering should classify ts_events partitions");
    const allowed = new Set(["nvme", "ssd", "glacier"]);
    for (const row of plan.rows) {
      assert.ok(allowed.has(row.storage_class), `bad class ${row.storage_class}`);
    }
    const listed = await query(db, "SELECT storage_class FROM ts_list_partitions('ts_events') WHERE storage_class IS NOT NULL");
    assert.ok(listed.rows.length >= 1, "storage class should be recorded in ts_parts");
  });
});
