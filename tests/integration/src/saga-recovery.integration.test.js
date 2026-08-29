/**
 * Integration coverage (Issue #36): saga persist -> simulated crash ->
 * recoverAll() resumes to completion, against a real Postgres-backed
 * SagaStore (apps/backend/orchestrator/src/saga/postgres-store.ts).
 *
 * "Crash" is simulated the same way the unit tests already do it (see
 * apps/backend/orchestrator/src/saga/coordinator crash-recovery unit
 * tests): a step's action throws mid-execution *and* the process that ran
 * it is discarded — a brand-new SagaCoordinator instance (fresh in-memory
 * step registry, no knowledge of what the first instance was doing) is
 * constructed against the *same* Postgres-backed store and asked to
 * recoverAll(). Because progress lives in Postgres rather than in the
 * coordinator's memory, the new instance can resume exactly where the old
 * one left off.
 *
 * All tests in this file share a single disposable database (created once
 * in before()) rather than one per test: apps/backend/orchestrator/src/saga/
 * postgres-store.ts's `sequelize` connection is created once at module-import
 * time from process.env.DATABASE_URL, and index.js re-exports it via a bare
 * (non-query-string) specifier — so re-importing the module with a different
 * `?db=` query string per test would only re-evaluate the thin index.js
 * wrapper, not get a genuinely fresh Postgres connection. Every saga/order id
 * is unique per test (uniqueId()) so sharing one database is safe.
 *
 * Requires the compiled orchestrator build (imports from dist/, matching
 * this workspace's existing integration-test convention — see
 * testcontainers-fixtures.test.js and wallet-ownership.test.js in
 * tests/unit) and a reachable Postgres. Skips itself when Postgres isn't
 * reachable, exactly like database-migrations.test.js.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { isPostgresReachable, isServiceBuilt, uniqueId } from "./helpers/infra.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MIGRATE_SCRIPT = path.join(REPO_ROOT, "scripts", "setup", "migrate.js");
const ADMIN_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego";

const dbAvailable = await isPostgresReachable();
if (!dbAvailable) {
  console.log(
    "[tests] Skipping saga recovery integration tests — no PostgreSQL reachable (start it with 'docker compose up -d postgres')",
  );
}

const orchestratorBuilt = isServiceBuilt("orchestrator");
if (dbAvailable && !orchestratorBuilt) {
  console.log(
    "[tests] Skipping saga recovery integration tests — apps/backend/orchestrator/dist not found (run `pnpm --filter @delegolabs/orchestrator build` first)",
  );
}

const suite = dbAvailable && orchestratorBuilt ? describe : describe.skip;

suite("saga crash recovery against real Postgres (#36)", () => {
  let databaseUrl;
  let PostgresSagaStore;
  let SagaCoordinator;
  let sagaSequelize;

  before(async () => {
    const dbName = uniqueId("delego_saga_test").replace(/-/g, "_");
    const adminUrl = new URL(ADMIN_DATABASE_URL);
    adminUrl.pathname = "/postgres";

    const admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${dbName}"`);
    } finally {
      await admin.end();
    }

    const dbUrl = new URL(ADMIN_DATABASE_URL);
    dbUrl.pathname = `/${dbName}`;
    databaseUrl = dbUrl.toString();

    const migrate = spawnSync(process.execPath, [MIGRATE_SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    assert.equal(migrate.status, 0, `migration run failed:\n${migrate.stderr}`);

    process.env.DATABASE_URL = databaseUrl;
    ({ PostgresSagaStore, SagaCoordinator, sagaSequelize } = await import(
      "../../../apps/backend/orchestrator/dist/src/saga/index.js"
    ));
  });

  after(async () => {
    await sagaSequelize?.close();

    const adminUrl = new URL(ADMIN_DATABASE_URL);
    adminUrl.pathname = "/postgres";
    const dbName = new URL(databaseUrl).pathname.slice(1);
    const cleanup = new pg.Client({ connectionString: adminUrl.toString() });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  });

  it("resumes a saga interrupted mid-step to completion via recoverAll()", async () => {
    const store = new PostgresSagaStore();

    // Step 2's action throws exactly once (simulating a crash mid-step); the second
    // coordinator instance's retry of the same step succeeds.
    let step2Attempts = 0;

    const steps = [
      {
        name: "reserve-inventory",
        action: async (ctx) => ({ ...ctx, reserved: true }),
        compensation: async (ctx) => ({ ...ctx, reserved: false }),
      },
      {
        name: "charge-payment",
        action: async (ctx) => {
          step2Attempts += 1;
          if (step2Attempts === 1) {
            throw new Error("simulated crash: process died mid charge-payment");
          }
          return { ...ctx, charged: true };
        },
        compensation: async (ctx) => ({ ...ctx, charged: false }),
      },
      {
        name: "confirm-order",
        action: async (ctx) => ({ ...ctx, confirmed: true }),
        compensation: async (ctx) => ({ ...ctx, confirmed: false }),
      },
    ];

    const sagaId = uniqueId("saga");
    const orderId = uniqueId("order");

    const firstCoordinator = new SagaCoordinator({ steps, store });

    // First run: step 1 completes and persists; step 2's action throws before it can
    // persist success. A real crash would also stop here — nothing on the coordinator's
    // side is caught upstream of run(), so this genuinely reproduces "process died".
    await assert.rejects(
      () => firstCoordinator.run(sagaId, orderId, { orderId }),
      /simulated crash/,
    );

    // Confirm the crash left the saga durably recorded as still in-flight, not lost.
    const midCrashRecord = await store.get(sagaId);
    assert.ok(midCrashRecord, "saga record must survive the crash (it's in Postgres, not memory)");
    assert.equal(midCrashRecord.status, "running");
    assert.deepEqual(midCrashRecord.completedSteps, ["reserve-inventory"]);

    // "Restart the orchestrator": brand-new SagaCoordinator with its own step closures
    // and call-tracking, wired to the same durable store.
    const recoveredCalls = [];
    const recoverySteps = steps.map((step) => ({
      ...step,
      action: async (ctx) => {
        const result = await step.action(ctx);
        recoveredCalls.push(step.name);
        return result;
      },
    }));
    const secondCoordinator = new SagaCoordinator({ steps: recoverySteps, store });

    await secondCoordinator.recoverAll();

    const finalRecord = await store.get(sagaId);
    assert.equal(finalRecord.status, "completed");
    assert.deepEqual(finalRecord.completedSteps, ["reserve-inventory", "charge-payment", "confirm-order"]);
    assert.equal(finalRecord.context.reserved, true);
    assert.equal(finalRecord.context.charged, true);
    assert.equal(finalRecord.context.confirmed, true);

    // Step 1's action must NOT have re-run on recovery (it's in completedSteps already) —
    // this is the "no duplicate side effects" guarantee the whole saga pattern exists for.
    assert.deepEqual(recoveredCalls, ["charge-payment", "confirm-order"]);
    assert.equal(step2Attempts, 2, "charge-payment retried exactly once after the simulated crash");
  });

  it("recoverAll() is a no-op for sagas that already completed", async () => {
    const store = new PostgresSagaStore();
    let actionCalls = 0;
    const steps = [
      {
        name: "only-step",
        action: async (ctx) => {
          actionCalls += 1;
          return { ...ctx, done: true };
        },
        compensation: async (ctx) => ctx,
      },
    ];

    const sagaId = uniqueId("saga-complete");
    const coordinator = new SagaCoordinator({ steps, store });
    await coordinator.run(sagaId, uniqueId("order"), {});
    assert.equal(actionCalls, 1);

    await coordinator.recoverAll();
    assert.equal(actionCalls, 1, "a completed saga must not re-execute its action on recovery");
  });
});
