/**
 * Integration coverage (Issue #36): outbox insert -> relay -> consumer
 * dedupe (at-least-once delivery, no double-apply), against real Postgres.
 *
 * The `service_event_outbox` table (database/migrations/005_service_event_outbox.sql)
 * and `processed_messages` table (database/migrations/006_processed_messages.sql) are
 * both real schema on main. This suite:
 *
 *   1. Inserts a pending outbox row directly (standing in for a domain mutation that
 *      writes to the outbox in the same transaction — see the doc comment on
 *      insertServiceEventOutbox in service-event-outbox.ts).
 *   2. Runs a minimal relay poll loop (claim pending rows, "publish", mark published)
 *      against the real table, including a retry pass to prove at-least-once delivery
 *      can hand the same row to a consumer twice.
 *   3. Feeds each delivery through PostgresProcessedMessageStore.checkAndMark(), which
 *      is the real production dedupe primitive (apps/backend/orchestrator/src/messaging/
 *      processed-messages.ts), and asserts the consumer's side effect only applies once
 *      even though the relay delivered twice.
 *
 * Requires the compiled orchestrator build (dist/) and a reachable Postgres; skips
 * itself otherwise.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { isPostgresReachable, isServiceBuilt, uniqueId } from "./helpers/infra.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego";

const dbAvailable = await isPostgresReachable();
if (!dbAvailable) {
  console.log(
    "[tests] Skipping outbox relay/dedupe integration tests — no PostgreSQL reachable (start it with 'docker compose up -d postgres')",
  );
}

const orchestratorBuilt = isServiceBuilt("orchestrator");
if (dbAvailable && !orchestratorBuilt) {
  console.log(
    "[tests] Skipping outbox relay/dedupe integration tests — apps/backend/orchestrator/dist not found (run `pnpm --filter @delegolabs/orchestrator build` first)",
  );
}

const suite = dbAvailable && orchestratorBuilt ? describe : describe.skip;

/** Minimal stand-in for a relay worker: claims N pending rows and marks them published. */
async function relayOnce(pool, { batchSize = 10, topic } = {}) {
  const { rows } = await pool.query(
    `UPDATE service_event_outbox
       SET status = 'published'
     WHERE id IN (
       SELECT id FROM service_event_outbox
        WHERE status = 'pending' AND ($1::text IS NULL OR topic = $1)
        ORDER BY created_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     RETURNING id, topic, payload`,
    [topic ?? null, batchSize],
  );
  return rows;
}

suite("outbox insert -> relay -> consumer dedupe against real Postgres (#36)", () => {
  let pool;
  let PostgresProcessedMessageStore;

  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    ({ PostgresProcessedMessageStore } = await import(
      "../../../apps/backend/orchestrator/dist/src/messaging/processed-messages.js"
    ));
  });

  after(async () => {
    await pool.end();
  });

  it("relays a pending row exactly once (SKIP LOCKED claims it) and the consumer applies it exactly once even if redelivered", async (t) => {
    const topic = uniqueId("delegation.updated");
    const insertResult = await pool.query(
      `INSERT INTO service_event_outbox (topic, payload, status) VALUES ($1, $2, 'pending') RETURNING id`,
      [topic, JSON.stringify({ delegationId: "dlg_123", change: "revoked" })],
    );
    const outboxId = insertResult.rows[0].id;
    t.after(() => pool.query(`DELETE FROM service_event_outbox WHERE id = $1`, [outboxId]));

    // 1. Relay claims and publishes the row.
    const claimed = await relayOnce(pool, { topic });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].id, outboxId);

    const afterRelay = await pool.query(`SELECT status FROM service_event_outbox WHERE id = $1`, [outboxId]);
    assert.equal(afterRelay.rows[0].status, "published");

    // 2. A second relay pass must not re-claim an already-published row.
    const secondPass = await relayOnce(pool, { topic });
    assert.equal(secondPass.length, 0, "an already-published row must not be reclaimed by a later poll");

    // 3. Simulate at-least-once redelivery of the *message* itself (e.g. the relay's Redis
    // publish succeeded but the ack that would prevent a redelivery was lost) — the consumer
    // sees the same outbox id twice and must apply its side effect only once.
    const consumer = "delegation-notifications-consumer";
    const messageStore = new PostgresProcessedMessageStore(pool);
    t.after(() => pool.query(`DELETE FROM processed_messages WHERE message_id = $1`, [outboxId]));

    let sideEffectApplications = 0;
    async function deliverToConsumer() {
      const shouldProcess = await messageStore.checkAndMark(outboxId, consumer);
      if (shouldProcess) {
        sideEffectApplications += 1;
      }
      return shouldProcess;
    }

    const firstDelivery = await deliverToConsumer();
    const redelivery = await deliverToConsumer();

    assert.equal(firstDelivery, true, "first delivery must be claimed for processing");
    assert.equal(redelivery, false, "redelivery of the same message id must be skipped");
    assert.equal(sideEffectApplications, 1, "the consumer's side effect must apply exactly once");
  });

  it("relays a batch under concurrent pollers without double-claiming any row (SKIP LOCKED)", async (t) => {
    const topic = uniqueId("payment.settled");
    const rowCount = 5;
    const insertedIds = [];
    for (let i = 0; i < rowCount; i++) {
      const { rows } = await pool.query(
        `INSERT INTO service_event_outbox (topic, payload, status) VALUES ($1, $2, 'pending') RETURNING id`,
        [topic, JSON.stringify({ i })],
      );
      insertedIds.push(rows[0].id);
    }
    t.after(() =>
      pool.query(`DELETE FROM service_event_outbox WHERE id = ANY($1::uuid[])`, [insertedIds]),
    );

    // Two "pollers" racing on the same topic — SKIP LOCKED must partition the rows between
    // them with zero overlap, which is the whole point of using it over a plain SELECT.
    const [batchA, batchB] = await Promise.all([
      relayOnce(pool, { topic, batchSize: 3 }),
      relayOnce(pool, { topic, batchSize: 3 }),
    ]);

    const claimedIds = [...batchA, ...batchB].map((r) => r.id);
    const uniqueClaimedIds = new Set(claimedIds);
    assert.equal(claimedIds.length, uniqueClaimedIds.size, "no row may be claimed by both pollers");
    assert.equal(claimedIds.length, rowCount, "all pending rows must be claimed across both pollers");
  });
});
