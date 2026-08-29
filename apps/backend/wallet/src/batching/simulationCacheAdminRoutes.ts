/**
 * Simulation Cache Admin API Routes
 * Issue #141
 *
 * GET  /admin/simulation/cache/metrics        – cache metrics
 * POST /admin/simulation/cache/invalidate      – invalidate cache
 * POST /admin/simulation/cache/warmup          – warmup cache
 * POST /admin/simulation/cache/contract-version – set contract version
 * GET  /admin/simulation/cache/config          – get cache config
 * POST /admin/simulation/cache/config          – update cache config
 */
import type { IncomingMessage } from "node:http";
import { route, json, type Route } from "@delegolabs/utils";
import {
  getSimulationCacheMetrics,
  invalidateContractCache,
  invalidateAllCache,
  setContractVersion,
  getContractVersion,
  warmupCache,
} from "../simulationCache.js";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("wallet:admin:simulation", process.env.LOG_LEVEL ?? "info");

async function readBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? (JSON.parse(body) as T) : ({} as T));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export function registerSimulationCacheAdminRoutes(): Route[] {
  return [
    // Get cache metrics
    route("GET", "/admin/simulation/cache/metrics", async (_req, res) => {
      try {
        const metrics = getSimulationCacheMetrics();
        json(res, 200, { data: metrics, error: null });
      } catch (err: any) {
        log.error("GET simulation cache metrics error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Invalidate cache
    route("POST", "/admin/simulation/cache/invalidate", async (req, res) => {
      try {
        const body = await readBody<{
          contractId?: string;
        }>(req);

        if (body.contractId) {
          const count = await invalidateContractCache(body.contractId);
          json(res, 200, { data: { invalidated: count, contractId: body.contractId }, error: null });
        } else {
          await invalidateAllCache();
          json(res, 200, { data: { invalidated: "all" }, error: null });
        }
      } catch (err: any) {
        log.error("POST invalidate cache error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Warmup cache
    route("POST", "/admin/simulation/cache/warmup", async (req, res) => {
      try {
        const body = await readBody<{
          patterns: Array<{
            contractId: string;
            method: string;
            sampleArgs: unknown[];
          }>;
        }>(req);

        if (!body.patterns || !Array.isArray(body.patterns)) {
          json(res, 400, {
            data: null,
            error: {
              code: "BAD_REQUEST",
              message: "patterns array is required",
            },
          });
          return;
        }

        const simulateFn = async (contractId: string, method: string, args: unknown[]) => {
          const { SorobanTransactionSimulator, readSorobanRpcConfig } = await import("../sorobanSimulator.js");
          const config = readSorobanRpcConfig();
          const simulator = new SorobanTransactionSimulator(config);
          const { Horizon, TransactionBuilder, Operation, Networks, nativeToScVal, Address } = await import("@stellar/stellar-sdk");

          const network = (process.env.STELLAR_NETWORK ?? "testnet").toLowerCase();
          const horizonUrl = network === "mainnet"
            ? process.env.STELLAR_HORIZON_URL ?? "https://horizon.stellar.org"
            : process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
          const networkPassphrase = network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

          const horizonServer = new Horizon.Server(horizonUrl);
          const sourceAccount = await horizonServer.loadAccount(process.env.WARMUP_SOURCE_ADDRESS ?? process.env.STELLAR_SOURCE_ADDRESS ?? "");

          const STELLAR_STRKEY_RE = /^[GC][A-Z2-7]{55}$/;
          const scArgs = args.map((arg) => {
            if (typeof arg === "string" && STELLAR_STRKEY_RE.test(arg)) {
              try { return Address.fromString(arg).toScVal(); } catch {}
            }
            return nativeToScVal(arg);
          });

          const tx = new TransactionBuilder(sourceAccount, {
            fee: "100",
            networkPassphrase,
          })
            .addOperation(
              Operation.invokeContractFunction({
                contract: contractId,
                function: method,
                args: scArgs,
              })
            )
            .setTimeout(30)
            .build();

          return simulator.simulateTransaction(tx);
        };

        const result = await warmupCache(body.patterns, simulateFn);
        json(res, 200, { data: result, error: null });
      } catch (err: any) {
        log.error("POST warmup cache error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Set contract version (triggers cache invalidation)
    route("POST", "/admin/simulation/cache/contract-version", async (req, res) => {
      try {
        const body = await readBody<{
          contractId: string;
          version: string;
        }>(req);

        if (!body.contractId || !body.version) {
          json(res, 400, {
            data: null,
            error: {
              code: "BAD_REQUEST",
              message: "contractId and version are required",
            },
          });
          return;
        }

        await setContractVersion(body.contractId, body.version);
        json(res, 200, {
          data: { contractId: body.contractId, version: body.version },
          error: null,
        });
      } catch (err: any) {
        log.error("POST set contract version error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Get contract version
    route("GET", "/admin/simulation/cache/contract-version/:contractId", async (_req, res, params) => {
      try {
        const version = await getContractVersion(params.contractId);
        json(res, 200, {
          data: { contractId: params.contractId, version: version ?? "unknown" },
          error: null,
        });
      } catch (err: any) {
        log.error("GET contract version error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),
  ];
}
