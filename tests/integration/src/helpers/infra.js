/**
 * Shared real-infrastructure probes for the integration suite (Issue #36).
 *
 * Every integration test file is responsible for skipping itself (via
 * `describe.skip`) when the infra it needs isn't reachable, exactly like
 * `database-migrations.test.js` already does for Postgres. This module
 * centralizes that probing so each new suite doesn't reimplement it.
 */
import pg from "pg";
import Redis from "ioredis";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

export const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego";
export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/** True when a real (non-mock) Postgres instance answers at BASE_DATABASE_URL. */
export async function isPostgresReachable() {
  const client = new pg.Client({ connectionString: BASE_DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * True when a real (non-mock) Redis instance answers at REDIS_URL.
 *
 * Intentionally does not consult MOCK_REDIS — this suite always wants a live
 * connection when one exists, so it can exercise the real command surface
 * (pipelining, TTL/expiry, key eviction) that ioredis-mock does not emulate.
 */
export async function isRedisReachable() {
  const client = new Redis(REDIS_URL, { lazyConnect: true, connectTimeout: 3000, retryStrategy: () => null });
  // ioredis emits an "error" event on a failed connect in addition to rejecting connect() —
  // without a listener that surfaces as an unhandled "error" event log even though we're
  // about to catch the rejection below and treat it as a normal "not reachable" result.
  client.on("error", () => {});
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

/** Picks a per-worker-unique table/key prefix so parallel test files never collide. */
export function uniqueId(prefix) {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/**
 * True when `apps/backend/<service>` has a compiled `dist/` directory.
 *
 * The suites that exercise real application code (as opposed to raw SQL against
 * migrated tables) import compiled output — matching this workspace's existing
 * convention (see testcontainers-fixtures.test.js, tests/unit's wallet-ownership
 * tests). `pnpm build` must run first (see the "Build services" step in the
 * test-integration CI job); when it hasn't (e.g. a stray local `pnpm
 * test:integration` run without a prior build), skip with a clear message
 * instead of failing on a raw MODULE_NOT_FOUND.
 */
export function isServiceBuilt(service) {
  return fs.existsSync(path.join(REPO_ROOT, "apps", "backend", service, "dist"));
}
