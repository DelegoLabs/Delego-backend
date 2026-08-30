/**
 * Gateway health registry (Issue #76)
 *
 * Registers the gateway's dependency checks:
 *   postgresql — critical (SELECT 1 against the shared Sequelize pool)
 *   redis      — critical (rate-limiter Redis PING)
 *   orchestrator / wallet / payments — non-critical downstream services,
 *   reported as "degraded" when unreachable so the gateway keeps serving
 *   traffic (graceful degradation) while making the problem visible.
 */

import { HealthRegistry, httpHealthCheck, type HealthCheckFn } from "@delegolabs/utils";
import { checkDatabaseHealth } from "./db.js";
import { getRedisHealth, type RedisHealth } from "./rateLimit/redisClient.js";

const SERVICE_URLS = {
  orchestrator: process.env.ORCHESTRATOR_SERVICE_URL ?? "http://localhost:3013",
  wallet: process.env.WALLET_SERVICE_URL ?? "http://localhost:3012",
  payments: process.env.PAYMENTS_SERVICE_URL ?? "http://localhost:3014",
} as const;

export type DownstreamServiceName = keyof typeof SERVICE_URLS;

export interface GatewayHealthOptions {
  checkDatabase?: () => Promise<number>;
  checkRedis?: () => Promise<RedisHealth>;
  fetchImpl?: typeof fetch;
  serviceUrls?: Record<DownstreamServiceName, string>;
  timeoutMs?: number;
}

function createDownstreamCheck(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): HealthCheckFn {
  const probe = httpHealthCheck({ url, timeoutMs, fetchImpl });
  return async () => {
    try {
      return await probe();
    } catch {
      // Unreachable downstream service is a degradation, not a gateway failure.
      return { status: "degraded", details: { url, error: "unreachable" } };
    }
  };
}

export function createGatewayHealthRegistry(
  options: GatewayHealthOptions = {},
): HealthRegistry {
  const {
    checkDatabase = () => checkDatabaseHealth(2000),
    checkRedis = () => getRedisHealth(),
    fetchImpl = fetch,
    serviceUrls = SERVICE_URLS,
    timeoutMs = 2000,
  } = options;

  const registry = new HealthRegistry();

  registry.register(
    "postgresql",
    async () => {
      const latencyMs = await checkDatabase();
      return { status: "healthy", details: { latencyMs: Math.round(latencyMs) } };
    },
    { type: "database", critical: true },
  );

  registry.register(
    "redis",
    async () => {
      const health = await checkRedis();
      if (health.status === "ok") {
        return { status: "healthy", details: { pingMs: health.pingMs } };
      }
      return { status: "degraded", details: { error: health.error } };
    },
    { type: "redis", critical: true },
  );

  const downstream: DownstreamServiceName[] = ["orchestrator", "wallet", "payments"];
  for (const name of downstream) {
    registry.register(
      name,
      createDownstreamCheck(`${serviceUrls[name].replace(/\/$/, "")}/health/ready`, timeoutMs, fetchImpl),
      { type: "http", critical: false },
    );
  }

  return registry;
}
