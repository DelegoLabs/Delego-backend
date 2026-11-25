import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "@delegolabs/utils";
import { getRedisClient } from "../src/rateLimit/redisClient.js";
import { Horizon } from "@stellar/stellar-sdk";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("gateway:stellar", process.env.LOG_LEVEL ?? "info");

export interface StellarFeePredictionResponse {
  lastLedgerSequence: number;
  baseFeeStroops: number;
  recommendations: {
    slow: number; // 50th percentile
    standard: number; // 75th percentile
    fast: number; // 95th percentile
  };
  congestionLevel: "low" | "moderate" | "surge";
  sampledLedgersCount: number;
}

interface HorizonFeeStats {
  last_ledger: number;
  last_ledger_base_fee: number;
  ledger_capacity_usage: number;
  fee_charged?: {
    min: number;
    max: number;
    mode: number;
    p10: number;
    p20: number;
    p30: number;
    p40: number;
    p50: number;
    p60: number;
    p70: number;
    p80: number;
    p90: number;
    p95: number;
    p99: number;
  };
  max_fee?: {
    min: number;
    max: number;
    mode: number;
    p10: number;
    p20: number;
    p30: number;
    p40: number;
    p50: number;
    p60: number;
    p70: number;
    p80: number;
    p90: number;
    p95: number;
    p99: number;
  };
}

const REDIS_CACHE_KEY = "stellar:fee_prediction";
const CACHE_TTL_SECONDS = 10;
const SURGE_CAPACITY_THRESHOLD = 0.8; // 80%

const HORIZON_URL =
  process.env.STELLAR_NETWORK === "mainnet"
    ? process.env.STELLAR_HORIZON_URL ?? "https://horizon.stellar.org"
    : process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";

function determineCongestionLevel(capacityUsage: number): "low" | "moderate" | "surge" {
  if (capacityUsage >= SURGE_CAPACITY_THRESHOLD) {
    return "surge";
  }
  if (capacityUsage >= 0.5) {
    return "moderate";
  }
  return "low";
}

function computeWeightedPercentiles(feeStats: HorizonFeeStats): {
  slow: number;
  standard: number;
  fast: number;
} {
  const baseFee = feeStats.last_ledger_base_fee || 100;
  const feeData = feeStats.max_fee || feeStats.fee_charged;

  if (!feeData) {
    return {
      slow: baseFee,
      standard: baseFee,
      fast: baseFee * 2,
    };
  }

  const p50 = feeData.p50 || baseFee;
  const p70 = feeData.p70 || p50;
  const p80 = feeData.p80 || p50;
  const p95 = feeData.p95 || baseFee * 2;

  const p75 = (p70 + p80) / 2;

  return {
    slow: Math.max(Math.round(p50), baseFee),
    standard: Math.max(Math.round(p75), baseFee),
    fast: Math.max(Math.round(p95), baseFee),
  };
}

async function fetchHorizonFeeStats(): Promise<HorizonFeeStats> {
  const server = new Horizon.Server(HORIZON_URL);
  const stats = (await server.feeStats()) as unknown;
  return stats as HorizonFeeStats;
}

async function getFeePrediction(): Promise<StellarFeePredictionResponse> {
  const redis = getRedisClient();

  try {
    const cached = await redis.get(REDIS_CACHE_KEY);
    if (cached) {
      log.debug("Returning cached fee prediction");
      return JSON.parse(cached) as StellarFeePredictionResponse;
    }
  } catch (err) {
    log.warn("Failed to read from Redis cache", { error: (err as Error).message });
  }

  const feeStats = await fetchHorizonFeeStats();
  const capacityUsage = feeStats.ledger_capacity_usage ?? 0;
  const congestionLevel = determineCongestionLevel(capacityUsage);
  const recommendations = computeWeightedPercentiles(feeStats);

  const response: StellarFeePredictionResponse = {
    lastLedgerSequence: feeStats.last_ledger,
    baseFeeStroops: feeStats.last_ledger_base_fee || 100,
    recommendations,
    congestionLevel,
    sampledLedgersCount: 100, // Horizon samples last 100 ledgers
  };

  try {
    await redis.setex(REDIS_CACHE_KEY, CACHE_TTL_SECONDS, JSON.stringify(response));
    log.debug("Cached fee prediction", { response });
  } catch (err) {
    log.warn("Failed to cache fee prediction", { error: (err as Error).message });
  }

  return response;
}

export async function stellarFeePredictionHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const prediction = await getFeePrediction();
    json(res, 200, {
      data: prediction,
      error: null,
    });
  } catch (err: any) {
    log.error("Failed to get fee prediction", { error: err.message });
    json(res, 500, {
      data: null,
      error: {
        code: "FEE_PREDICTION_ERROR",
        message: err.message || "Failed to fetch fee prediction from Horizon",
      },
    });
  }
}
