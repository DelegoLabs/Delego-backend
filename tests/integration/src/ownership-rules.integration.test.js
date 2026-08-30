/**
 * Integration coverage (Issue #36): delegation/wallet ownership rules
 * against a real, migrated Postgres database.
 *
 * apps/backend/gateway/middleware/walletOwnership.ts and
 * apps/backend/gateway/middleware/delegationOwnership.ts are exercised in
 * tests/unit/src/wallet-ownership.test.js with Wallet.findByPk *mocked*.
 * This suite instead creates real users/wallets/delegations rows (foreign
 * keys, unique constraints, and all) and calls the real ownership-check
 * functions against them, so it catches things the mocked unit test
 * structurally cannot: FK violations, real userId type/format mismatches,
 * and correct "not found" vs. "found but not owned" behavior against
 * actual query results rather than a hand-rolled mock return value.
 *
 * Requires the compiled gateway build (dist/) and a reachable Postgres;
 * skips itself otherwise.
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
    "[tests] Skipping ownership-rules integration tests — no PostgreSQL reachable (start it with 'docker compose up -d postgres')",
  );
}

const gatewayBuilt = isServiceBuilt("gateway");
if (dbAvailable && !gatewayBuilt) {
  console.log(
    "[tests] Skipping ownership-rules integration tests — apps/backend/gateway/dist not found (run `pnpm --filter @delegolabs/gateway build` first)",
  );
}

const suite = dbAvailable && gatewayBuilt ? describe : describe.skip;

suite("delegation/wallet ownership rules against real Postgres (#36)", () => {
  let databaseUrl;
  let checkWalletOwnership;
  let checkDelegationOwnership;
  let User;
  let Wallet;
  let Delegation;
  let sequelize;

  before(async () => {
    const dbName = uniqueId("delego_ownership_test").replace(/-/g, "_");
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
    // This file only imports each dist module once (here), so there's no risk of a
    // stale module-cached connection leaking across tests the way a per-test
    // re-import (with a different DATABASE_URL each time) would.
    ({ checkWalletOwnership } = await import(
      "../../../apps/backend/gateway/dist/middleware/walletOwnership.js"
    ));
    ({ checkDelegationOwnership } = await import(
      "../../../apps/backend/gateway/dist/middleware/delegationOwnership.js"
    ));
    ({ User, Wallet, Delegation } = await import(
      "../../../apps/backend/gateway/dist/src/models/index.js"
    ));
    ({ sequelize } = await import("../../../apps/backend/gateway/dist/src/db.js"));
  });

  after(async () => {
    await sequelize?.close();

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

  async function createUser() {
    return User.create({ email: `${uniqueId("owner")}@example.com`, passwordHash: "x", displayName: "Owner" });
  }

  it("owned=true when the wallet's real userId matches the caller", async () => {
    const owner = await createUser();
    const wallet = await Wallet.create({
      userId: owner.id,
      stellarAddress: uniqueId("G").slice(0, 56).toUpperCase(),
      publicKey: "pub-key-material",
    });

    const result = await checkWalletOwnership(owner.id, wallet.id);
    assert.deepEqual(result, { userId: owner.id, walletId: wallet.id, owned: true });
  });

  it("owned=false when the wallet exists but belongs to a different real user", async () => {
    const owner = await createUser();
    const other = await createUser();
    const wallet = await Wallet.create({
      userId: owner.id,
      stellarAddress: uniqueId("G").slice(0, 56).toUpperCase(),
      publicKey: "pub-key-material",
    });

    const result = await checkWalletOwnership(other.id, wallet.id);
    assert.deepEqual(result, { userId: other.id, walletId: wallet.id, owned: false });
  });

  it("owned=false when the wallet id does not exist in the database", async () => {
    const caller = await createUser();
    const result = await checkWalletOwnership(caller.id, "00000000-0000-0000-0000-000000000000");
    assert.deepEqual(result, {
      userId: caller.id,
      walletId: "00000000-0000-0000-0000-000000000000",
      owned: false,
    });
  });

  it("owned=true when the delegation's real userId matches the caller", async () => {
    const owner = await createUser();
    const delegation = await Delegation.create({
      userId: owner.id,
      agentId: "agent-shopping-bot",
      status: "active",
      policy: { maxPerTransaction: 100 },
    });

    const result = await checkDelegationOwnership(owner.id, delegation.id);
    assert.deepEqual(result, { userId: owner.id, delegationId: delegation.id, owned: true });
  });

  it("owned=false when the delegation exists but belongs to a different real user", async () => {
    const owner = await createUser();
    const other = await createUser();
    const delegation = await Delegation.create({
      userId: owner.id,
      agentId: "agent-shopping-bot",
      status: "active",
      policy: {},
    });

    const result = await checkDelegationOwnership(other.id, delegation.id);
    assert.deepEqual(result, { userId: other.id, delegationId: delegation.id, owned: false });
  });

  it("owned=false when the delegation id does not exist in the database", async () => {
    const caller = await createUser();
    const result = await checkDelegationOwnership(caller.id, "00000000-0000-0000-0000-000000000000");
    assert.deepEqual(result, {
      userId: caller.id,
      delegationId: "00000000-0000-0000-0000-000000000000",
      owned: false,
    });
  });

  it("rejects creating a wallet for a userId with no matching row (real FK constraint enforced)", async () => {
    await assert.rejects(
      () =>
        Wallet.create({
          userId: "00000000-0000-0000-0000-000000000000",
          stellarAddress: uniqueId("G").slice(0, 56).toUpperCase(),
          publicKey: "pub-key-material",
        }),
      /foreign key|violates/i,
    );
  });
});
