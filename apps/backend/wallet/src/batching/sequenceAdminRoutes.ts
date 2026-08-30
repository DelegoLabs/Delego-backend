/**
 * Sequence Reservation Admin API Routes
 * Issue #140
 *
 * GET  /admin/sequence/metrics/:account      – reservation metrics
 * GET  /admin/sequence/reservations/:account  – list active reservations
 * GET  /admin/sequence/gaps/:account          – list detected gaps
 * POST /admin/sequence/gaps/resolve           – resolve a gap
 * POST /admin/sequence/force-release          – force release a reservation
 * POST /admin/sequence/pre-warm               – pre-warm reservations
 * GET  /admin/sequence/audit/:account         – audit trail
 * POST /admin/sequence/high-throughput        – mark/unmark high-throughput account
 * GET  /admin/sequence/lock/:account          – lock monitoring status
 */
import type { IncomingMessage } from "node:http";
import { route, json, type Route } from "@delegolabs/utils";
import { getRedisConnection } from "../queue/txQueue.js";
import {
  getReservationMetrics,
  getSequenceGaps,
  resolveSequenceGap,
  forceReleaseReservation,
  preWarmReservations,
  getAuditTrail,
  monitorLockAcquisition,
  markHighThroughputAccount,
  unmarkHighThroughputAccount,
  detectAndCleanupLeakedReservations,
} from "../queue/sequenceMonitoring.js";
import { reserveSequenceBlock } from "../queue/txQueue.js";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("wallet:admin:sequence", process.env.LOG_LEVEL ?? "info");

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

function getHorizonServer() {
  const { Horizon } = require("@stellar/stellar-sdk");
  const network = (process.env.STELLAR_NETWORK ?? "testnet").toLowerCase();
  const horizonUrl =
    network === "mainnet"
      ? process.env.STELLAR_HORIZON_URL ?? "https://horizon.stellar.org"
      : process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
  return new Horizon.Server(horizonUrl);
}

export function registerSequenceAdminRoutes(): Route[] {
  return [
    // Get reservation metrics for an account
    route("GET", "/admin/sequence/metrics/:account", async (_req, res, params) => {
      try {
        const redis = getRedisConnection();
        const metrics = await getReservationMetrics(params.account, redis);
        json(res, 200, { data: metrics, error: null });
      } catch (err: any) {
        log.error("GET sequence metrics error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // List active reservations for an account
    route("GET", "/admin/sequence/reservations/:account", async (_req, res, params) => {
      try {
        const redis = getRedisConnection();
        const key = `seq:reservations:${params.account}`;
        const reservationsJson = await redis.lrange(key, 0, -1);
        const reservations = reservationsJson
          .map((json) => {
            try {
              return JSON.parse(json);
            } catch {
              return null;
            }
          })
          .filter(Boolean);

        json(res, 200, { data: reservations, error: null });
      } catch (err: any) {
        log.error("GET sequence reservations error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // List detected sequence gaps
    route("GET", "/admin/sequence/gaps/:account", async (_req, res, params) => {
      try {
        const redis = getRedisConnection();
        const gaps = await getSequenceGaps(params.account, redis);
        json(res, 200, { data: gaps, error: null });
      } catch (err: any) {
        log.error("GET sequence gaps error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Resolve a sequence gap
    route("POST", "/admin/sequence/gaps/resolve", async (req, res) => {
      try {
        const body = await readBody<{
          account: string;
          expectedSequence: string;
        }>(req);

        if (!body.account || !body.expectedSequence) {
          json(res, 400, {
            data: null,
            error: {
              code: "BAD_REQUEST",
              message: "account and expectedSequence are required",
            },
          });
          return;
        }

        const redis = getRedisConnection();
        const resolved = await resolveSequenceGap(
          body.account,
          body.expectedSequence,
          redis
        );

        json(res, 200, {
          data: { resolved },
          error: null,
        });
      } catch (err: any) {
        log.error("POST resolve gap error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Force release a reservation
    route("POST", "/admin/sequence/force-release", async (req, res) => {
      try {
        const body = await readBody<{
          account: string;
          leaseId: string;
          reason: string;
        }>(req);

        if (!body.account || !body.leaseId || !body.reason) {
          json(res, 400, {
            data: null,
            error: {
              code: "BAD_REQUEST",
              message: "account, leaseId, and reason are required",
            },
          });
          return;
        }

        const redis = getRedisConnection();
        const released = await forceReleaseReservation(
          body.account,
          body.leaseId,
          redis,
          body.reason
        );

        json(res, 200, {
          data: { released },
          error: null,
        });
      } catch (err: any) {
        log.error("POST force release error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Pre-warm reservations
    route("POST", "/admin/sequence/pre-warm", async (req, res) => {
      try {
        const body = await readBody<{
          account: string;
          size?: number;
        }>(req);

        if (!body.account) {
          json(res, 400, {
            data: null,
            error: {
              code: "BAD_REQUEST",
              message: "account is required",
            },
          });
          return;
        }

        const redis = getRedisConnection();
        const horizonServer = getHorizonServer();
        const size = body.size ?? 50;

        const reservations = await preWarmReservations(
          body.account,
          size,
          redis,
          (address, sz) => reserveSequenceBlock(address, sz, redis, horizonServer)
        );

        json(res, 200, {
          data: {
            preWarmed: reservations.length,
            reservations: reservations.map((r) => ({
              leaseId: r.leaseId,
              firstSequence: r.firstSequence,
              lastSequence: r.lastSequence,
              size: r.size,
            })),
          },
          error: null,
        });
      } catch (err: any) {
        log.error("POST pre-warm error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Get audit trail
    route("GET", "/admin/sequence/audit/:account", async (req, res, params) => {
      try {
        const redis = getRedisConnection();
        const url = new URL(
          req.url ?? "",
          `http://${req.headers.host ?? "localhost"}`
        );
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? parseInt(limitParam) : 100;

        const auditTrail = await getAuditTrail(params.account, redis, limit);
        json(res, 200, { data: auditTrail, error: null });
      } catch (err: any) {
        log.error("GET audit trail error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Mark/unmark high-throughput account
    route("POST", "/admin/sequence/high-throughput", async (req, res) => {
      try {
        const body = await readBody<{
          account: string;
          enabled: boolean;
        }>(req);

        if (!body.account) {
          json(res, 400, {
            data: null,
            error: {
              code: "BAD_REQUEST",
              message: "account is required",
            },
          });
          return;
        }

        const redis = getRedisConnection();
        if (body.enabled) {
          await markHighThroughputAccount(body.account, redis);
        } else {
          await unmarkHighThroughputAccount(body.account, redis);
        }

        json(res, 200, {
          data: { account: body.account, highThroughput: body.enabled },
          error: null,
        });
      } catch (err: any) {
        log.error("POST high-throughput error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Get lock monitoring status
    route("GET", "/admin/sequence/lock/:account", async (_req, res, params) => {
      try {
        const redis = getRedisConnection();
        const lockInfo = await monitorLockAcquisition(params.account, redis);
        json(res, 200, { data: lockInfo, error: null });
      } catch (err: any) {
        log.error("GET lock status error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Cleanup leaked reservations
    route("POST", "/admin/sequence/cleanup", async (req, res) => {
      try {
        const body = await readBody<{
          account: string;
        }>(req);

        if (!body.account) {
          json(res, 400, {
            data: null,
            error: {
              code: "BAD_REQUEST",
              message: "account is required",
            },
          });
          return;
        }

        const redis = getRedisConnection();
        const result = await detectAndCleanupLeakedReservations(body.account, redis);

        json(res, 200, {
          data: {
            cleaned: result.cleaned,
            leakedCount: result.leaked.length,
          },
          error: null,
        });
      } catch (err: any) {
        log.error("POST cleanup error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),
  ];
}
