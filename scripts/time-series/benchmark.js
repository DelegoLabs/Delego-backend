#!/usr/bin/env node
// Time-range query benchmark harness for the native time-series subsystem
// (database/migrations/026_time_series_optimization.sql).
//
// Seeds a burst of sample rows across several day partitions, then measures
// ts_benchmark_time_range() for a bounded window and compares the measured
// latency against the < 50 ms acceptance target. It also reports all
// partitions and their tiering class via ts_list_partitions().
//
// Usage: node scripts/time-series/benchmark.js [--rows 10000]
const { Client } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego";
const TARGET_MS = 50;

function parseArgs(argv) {
  const args = { rows: 10000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--rows" && argv[i + 1]) {
      args.rows = Number.parseInt(argv[i + 1], 10);
    }
  }
  return args;
}

async function seed(client, rows) {
  console.log(`[ts-benchmark] seeding ${rows} rows across ts_events / ts_metrics...`);
  // Distribute rows across the current + next two day partitions (the ones
  // ts_create_partitions_for_table created), so a bounded query must prune to
  // a subset — demonstrating partition pruning rather than a full scan.
  const now = Date.now();
  for (let i = 0; i < rows; i++) {
    const ts = new Date(now + (i % 3) * 24 * 3600 * 1000).toISOString();
    await client.query(
      `INSERT INTO ts_events (ts, event_type, entity_id, payload)
       VALUES ($1, $2, $3, $4)`,
      [ts, `type_${i % 10}`, `entity_${i % 100}`, JSON.stringify({ i })],
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    await seed(client, args.rows);

    const windows = [
      { label: "last 1 hour", from: "NOW() - INTERVAL '1 hour'", to: "NOW()" },
      { label: "last 1 day", from: "NOW() - INTERVAL '1 day'", to: "NOW()" },
      { label: "last 7 days", from: "NOW() - INTERVAL '7 days'", to: "NOW()" },
    ];

    let pass = true;
    console.log("\n[ts-benchmark] time-range query latency (ts_events):");
    for (const w of windows) {
      const res = await client.query(
        "SELECT * FROM ts_benchmark_time_range('ts_events', " + w.from + ", " + w.to + ")",
      );
      const row = res.rows[0];
      const ok = row?.execution_ms < TARGET_MS;
      if (!ok) pass = false;
      console.log(
        `  ${w.label.padEnd(14)} partitions=${String(row?.partitions_in_window).padStart(2)}  ` +
          `${row?.execution_ms?.toFixed(3)}ms  ${ok ? "PASS" : "FAIL (<50ms)"}`,
      );
    }

    const parts = await client.query("SELECT * FROM ts_list_partitions('ts_events')");
    console.log(`\n[ts-benchmark] ts_events partitions (${parts.rows.length}):`);
    for (const p of parts.rows) {
      console.log(`  ${p.partition_name}  ${p.upper_bound?.toISOString()}  class=${p.storage_class ?? "-"}`);
    }

    const agg = await client.query("SELECT * FROM ts_refresh_continuous_aggregates()");
    console.log(`\n[ts-benchmark] aggregates refreshed: ${agg.rows.map((r) => r.view_name).join(", ") || "(none)"}`);
    const daily = await client.query(
      "SELECT bucket::date AS d, event_type, event_count FROM ts_events_daily ORDER BY bucket",
    );
    console.log(`[ts-benchmark] ts_events_daily rows: ${daily.rows.length}`);

    console.log(`\n[ts-benchmark] RESULT: ${pass ? "PASS" : "FAIL"} (target < ${TARGET_MS}ms)`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`[ts-benchmark] fatal: ${err.message}`);
  process.exit(1);
});
