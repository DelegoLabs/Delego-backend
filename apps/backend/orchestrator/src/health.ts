/**
 * Orchestrator service health registry (Issue #76)
 *
 * Dependencies:
 *   postgres — critical (saga + workflow persistence)
 *   redis    — non-critical (workflow event pub/sub)
 */

import { HealthRegistry, httpHealthCheck, type HealthCheckFn } from "@delegolabs/utils";
import { Pool } from "pg";

export interface OrchestratorHealthOptions {
  checkPostgres?: () => Promise<void>;
  fetchImpl?: typeof fetch;
  redisUrl?: string;
}

function createPostgresCheck(checkPostgres?: () => Promise<void>): HealthCheckFn {
  if (checkPostgres) return async () => { await checkPostgres(); return { status: "healthy" as const }; };

  let pool: Pool | null = null;
  return async () => {
    if (!pool) {
      pool = new Pool({
        connectionString: process.env.DATABASE_URL ?? "postgresql://delego:delego@localhost:5432/delego",
        max: 1,
      });
    }
    try {
      await pool.query("SELECT 1");
      return { status: "healthy", details: { engine: "postgresql" } };
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  };
}

export function createOrchestratorHealthRegistry(
  options: OrchestratorHealthOptions = {},
): HealthRegistry {
  const { checkPostgres, fetchImpl = fetch, redisUrl } = options;

  const registry = new HealthRegistry();

  registry.register("postgres", createPostgresCheck(checkPostgres), {
    type: "database",
    critical: true,
  });

  registry.register(
    "redis",
    httpHealthCheck({
      url: redisUrl ?? (process.env.REDIS_URL ?? "redis://localhost:6379").replace(/^redis:\/\//, "http://"),
      timeoutMs: 2000,
      fetchImpl,
    }),
    { type: "redis", critical: false },
  );

  return registry;
}
