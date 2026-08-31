#!/usr/bin/env node
// Time-series maintenance job for the native PostgreSQL time-series subsystem
// introduced in database/migrations/026_time_series_optimization.sql.
//
// Runs the three automation entry points on an interval (or once when given
// --once):
//   1. ts_maintain()                         -> create look-ahead + drop expired
//      partitions (retention policy enforcement + partition automation)
//   2. ts_refresh_continuous_aggregates()    -> CONCURRENTLY refresh materialized
//      continuous aggregates
//   3. ts_apply_tiering()                    -> classify partitions hot/warm/cold
//
// Wire this up to your scheduler/cron, e.g.:
//   node scripts/time-series/maintain.js --interval 60
const { Client } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego";

function parseArgs(argv) {
  const args = { intervalSec: 0, once: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--interval" && argv[i + 1]) {
      args.intervalSec = Number.parseInt(argv[i + 1], 10) * 60;
      i++;
    } else if (argv[i] === "--once") {
      args.once = true;
    }
  }
  return args;
}

async function runCycle(client) {
  const maintain = await client.query("SELECT * FROM ts_maintain(2)");
  console.log(
    `[ts-maintain] partitions — ${maintain.rows
      .map((r) => `${r.table_name} (+${r.partitions_created}/-${r.partitions_dropped})`)
      .join(", ")}`,
  );

  const refresh = await client.query("SELECT * FROM ts_refresh_continuous_aggregates()");
  console.log(
    `[ts-maintain] aggregates refreshed — ${refresh.rows.map((r) => r.view_name).join(", ") || "(none)"}`,
  );

  const tiering = await client.query("SELECT * FROM ts_apply_tiering()");
  console.log(
    `[ts-maintain] tiering — ${tiering.rows
      .map((r) => `${r.partition_name}=${r.storage_class}(${r.action})`)
      .join(", ") || "(none)"}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const run = async () => {
    try {
      await runCycle(client);
    } catch (err) {
      console.error(`[ts-maintain] cycle failed: ${err.message}`);
    }
  };

  if (args.once || args.intervalSec <= 0) {
    await run();
    return;
  }

  console.log(`[ts-maintain] poll interval: ${args.intervalSec}s`);
  await run();
  setInterval(run, args.intervalSec * 1000);

  const shutdown = async () => {
    await client.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[ts-maintain] fatal: ${err.message}`);
  process.exit(1);
});
