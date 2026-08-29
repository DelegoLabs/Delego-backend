/**
 * Wallet service health registry (Issue #76)
 *
 * Dependencies:
 *   database  — critical (PostgreSQL connectivity)
 *   redis     — critical (transaction queue / balance cache)
 *   sorobanRpc — non-critical (Soroban RPC endpoint)
 */

import { HealthRegistry, httpHealthCheck } from "@delegolabs/utils";
import { sequelize } from "./db.js";
import { getRedisConnection } from "./queue/txQueue.js";
import { readSorobanRpcConfig } from "./sorobanSimulator.js";

export interface WalletHealthOptions {
  checkDatabase?: () => Promise<void>;
  checkRedis?: () => Promise<void>;
  fetchImpl?: typeof fetch;
  rpcUrl?: string;
}

function pingRedis(): Promise<void> {
  const redis = getRedisConnection();
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_, rejectFn) => {
      timer = setTimeout(() => rejectFn(new Error("Redis ping timed out")), 2000);
    });
    Promise.race([redis.ping(), timeout])
      .then(() => resolve())
      .catch(reject)
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
  });
}

export function createWalletHealthRegistry(options: WalletHealthOptions = {}): HealthRegistry {
  const {
    checkDatabase = async () => {
      await sequelize.query("SELECT 1");
    },
    checkRedis = () => pingRedis(),
    fetchImpl = fetch,
    rpcUrl = readSorobanRpcConfig().rpcUrl,
  } = options;

  const registry = new HealthRegistry();

  registry.register(
    "database",
    async () => {
      await checkDatabase();
      return { status: "healthy", details: { engine: "postgresql" } };
    },
    { type: "database", critical: true },
  );

  registry.register(
    "redis",
    async () => {
      await checkRedis();
      return { status: "healthy", details: { role: "queue-cache" } };
    },
    { type: "redis", critical: true },
  );

  registry.register(
    "sorobanRpc",
    httpHealthCheck({ url: rpcUrl, timeoutMs: 2000, fetchImpl }),
    { type: "grpc", critical: false },
  );

  return registry;
}
