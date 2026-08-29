/**
 * Payments service health registry (Issue #76)
 *
 * Dependencies:
 *   database     — critical (PostgreSQL connectivity)
 *   walletService — non-critical (wallet /health/ready)
 *   sorobanRpc   — non-critical (Soroban RPC getHealth)
 */

import { HealthRegistry } from "@delegolabs/utils";
import { getWalletUrl } from "../escrow/config.js";
import {
  checkDatabaseConnectivity,
  checkSorobanRpcReadiness,
  checkWalletServiceReadiness,
  getSorobanRpcUrl,
} from "../escrow/health.js";

export interface PaymentsHealthOptions {
  checkDatabase?: () => Promise<"ok" | "degraded">;
  checkWallet?: () => Promise<"ok" | "degraded">;
  checkSorobanRpc?: () => Promise<"ok" | "degraded">;
}

export function createPaymentsHealthRegistry(
  options: PaymentsHealthOptions = {},
): HealthRegistry {
  const {
    checkDatabase = () => checkDatabaseConnectivity(),
    checkWallet = () => checkWalletServiceReadiness(getWalletUrl()),
    checkSorobanRpc = () => checkSorobanRpcReadiness(getSorobanRpcUrl()),
  } = options;

  const registry = new HealthRegistry();

  registry.register(
    "database",
    async () => {
      const status = await checkDatabase();
      return status === "ok"
        ? { status: "healthy", details: { engine: "postgresql" } }
        : { status: "degraded", details: { engine: "postgresql" } };
    },
    { type: "database", critical: true },
  );

  registry.register(
    "walletService",
    async () => {
      const status = await checkWallet();
      return status === "ok"
        ? { status: "healthy", details: { url: getWalletUrl() } }
        : { status: "degraded", details: { url: getWalletUrl() } };
    },
    { type: "http", critical: false },
  );

  registry.register(
    "sorobanRpc",
    async () => {
      const status = await checkSorobanRpc();
      return status === "ok"
        ? { status: "healthy", details: { url: getSorobanRpcUrl() } }
        : { status: "degraded", details: { url: getSorobanRpcUrl() } };
    },
    { type: "grpc", critical: false },
  );

  return registry;
}
