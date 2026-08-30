/**
 * Integration coverage (Issue #36): auth register/login/refresh round-trip
 * against a real, migrated Postgres database.
 *
 * Unlike the gateway's unit tests (apps/backend/gateway/src/auth/*.test.ts),
 * which mock Sequelize model calls, this suite runs the real
 * apps/backend/gateway/src/auth/authService.ts functions against actual
 * `users` / `refresh_tokens` rows created by the migration runner — so it
 * catches things unit tests structurally cannot: SQL/column-mapping bugs
 * (e.g. camelCase model attribute vs. underscored column), unique
 * constraint behavior, and the full register -> login -> refresh -> theft
 * detection flow persisting correctly across real transactions.
 *
 * Requires the compiled gateway build (dist/) and a reachable Postgres;
 * skips itself otherwise, exactly like database-migrations.test.js.
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
    "[tests] Skipping auth round-trip integration tests — no PostgreSQL reachable (start it with 'docker compose up -d postgres')",
  );
}

const gatewayBuilt = isServiceBuilt("gateway");
if (dbAvailable && !gatewayBuilt) {
  console.log(
    "[tests] Skipping auth round-trip integration tests — apps/backend/gateway/dist not found (run `pnpm --filter @delegolabs/gateway build` first)",
  );
}

const suite = dbAvailable && gatewayBuilt ? describe : describe.skip;

suite("auth register/login/refresh round-trip against real Postgres (#36)", () => {
  let databaseUrl;
  let authService;
  let sequelize;

  before(async (t) => {
    const dbName = uniqueId("delego_auth_test").replace(/-/g, "_");
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
    process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
    // authService.js pulls in db.js at import time, which opens its Sequelize
    // connection from process.env.DATABASE_URL — must be set before this import.
    // This file only imports authService once (here), so there's no risk of a stale
    // module-cached connection leaking across tests the way a per-test re-import would.
    authService = await import("../../../apps/backend/gateway/dist/src/auth/authService.js");
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

  it("registers a new user with a real row in `users` and issues a valid token pair", async () => {
    const email = `${uniqueId("user")}@example.com`;
    const result = await authService.registerUser(email, "correct horse battery staple", "Test User");

    assert.equal(result.user.email, email);
    assert.equal(result.user.displayName, "Test User");
    assert.match(result.user.id, /^[0-9a-f-]{36}$/i, "User.id must be a real UUID from the DB default");
    assert.ok(result.accessToken);
    assert.ok(result.refreshToken);

    const claims = authService.verifyToken(result.accessToken);
    assert.equal(claims.userId, result.user.id);
  });

  it("rejects registering the same email twice (unique constraint enforced end-to-end)", async () => {
    const email = `${uniqueId("dup-user")}@example.com`;
    await authService.registerUser(email, "first-password-123", "First");

    await assert.rejects(
      () => authService.registerUser(email, "second-password-456", "Second"),
      /already exists/,
    );
  });

  it("logs in with the stored password hash and rejects a wrong password", async () => {
    const email = `${uniqueId("login-user")}@example.com`;
    const password = "correct-password-789";
    await authService.registerUser(email, password, "Login User");

    const loginResult = await authService.loginUser(email, password);
    assert.equal(loginResult.user.email, email);
    assert.ok(loginResult.accessToken);

    await assert.rejects(
      () => authService.loginUser(email, "wrong-password"),
      /Invalid email or password/,
    );
  });

  it("rotates the refresh token on refresh and detects reuse of a rotated-out token as theft", async () => {
    const email = `${uniqueId("refresh-user")}@example.com`;
    const registerResult = await authService.registerUser(email, "a-strong-password-000", "Refresh User");

    const rotated = await authService.refreshAccessToken(registerResult.refreshToken);
    assert.ok(rotated.accessToken);
    assert.ok(rotated.refreshToken);
    assert.notEqual(rotated.refreshToken, registerResult.refreshToken, "refresh must issue a new token, not reuse the old one");

    // The refresh token from registration was rotated out by the call above — presenting
    // it again is exactly the "stolen/replayed token" scenario the family-revocation
    // mechanism (Issue #77 — JWT token management) exists to catch.
    await assert.rejects(
      () => authService.refreshAccessToken(registerResult.refreshToken),
      /.+/,
      "reusing an already-rotated refresh token must be rejected",
    );

    // Theft detection must also have revoked the *new* token from the same family, so the
    // legitimate holder is forced to re-authenticate rather than silently keep a session
    // an attacker has already touched.
    await assert.rejects(
      () => authService.refreshAccessToken(rotated.refreshToken),
      /.+/,
      "the entire token family must be revoked once reuse is detected",
    );
  });

  it("logs out a refresh token so it can no longer be used to refresh", async () => {
    const email = `${uniqueId("logout-user")}@example.com`;
    const registerResult = await authService.registerUser(email, "another-strong-pw-111", "Logout User");

    await authService.logoutUser(registerResult.refreshToken);

    await assert.rejects(() => authService.refreshAccessToken(registerResult.refreshToken), /.+/);
  });
});
