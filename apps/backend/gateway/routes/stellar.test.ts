import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { stellarFeePredictionHandler } from "./stellar.js";

const { redisGet, redisSetex, feeStatsMock } = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSetex: vi.fn(),
  feeStatsMock: vi.fn(),
}));

vi.mock("../src/rateLimit/redisClient.js", () => ({
  getRedisClient: vi.fn(() => ({
    get: redisGet,
    setex: redisSetex,
  })),
}));

vi.mock("@stellar/stellar-sdk", () => ({
  Horizon: {
    Server: vi.fn().mockImplementation(() => ({
      feeStats: feeStatsMock,
    })),
  },
}));

type MockResponse = ServerResponse & {
  statusCode: number;
  body: string;
  headersSent: boolean;
  setHeader(name: string, value: string | number): void;
  writeHead(status: number): void;
  end(body?: string): void;
};

function createResponse(): MockResponse {
  return {
    statusCode: 0,
    body: "",
    headersSent: false,
    setHeader() {},
    writeHead(status: number) {
      this.statusCode = status;
      this.headersSent = true;
    },
    end(body?: string) {
      if (body) this.body = body;
    },
  } as MockResponse;
}

function createRequest(): IncomingMessage {
  return new EventEmitter() as IncomingMessage;
}

describe("GET /api/v1/stellar/fee-prediction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisGet.mockResolvedValue(null);
    redisSetex.mockResolvedValue("OK");
  });

  it("returns cached fee prediction without calling Horizon", async () => {
    const cached = {
      lastLedgerSequence: 500000,
      baseFeeStroops: 100,
      recommendations: { slow: 100, standard: 150, fast: 300 },
      congestionLevel: "low",
      sampledLedgersCount: 100,
    };
    redisGet.mockResolvedValue(JSON.stringify(cached));

    const res = createResponse();
    await stellarFeePredictionHandler(createRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ data: cached, error: null });
    expect(feeStatsMock).not.toHaveBeenCalled();
    expect(redisSetex).not.toHaveBeenCalled();
  });

  it("computes recommendations, classifies congestion, and caches result on cache miss", async () => {
    feeStatsMock.mockResolvedValue({
      last_ledger: 123456,
      last_ledger_base_fee: 100,
      ledger_capacity_usage: 0.65,
      max_fee: {
        p50: 120,
        p70: 200,
        p80: 300,
        p95: 500,
      },
    });

    const res = createResponse();
    await stellarFeePredictionHandler(createRequest(), res);

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed).toEqual({
      data: {
        lastLedgerSequence: 123456,
        baseFeeStroops: 100,
        recommendations: {
          slow: 120,
          standard: 250,
          fast: 500,
        },
        congestionLevel: "moderate",
        sampledLedgersCount: 100,
      },
      error: null,
    });
    expect(redisSetex).toHaveBeenCalledWith(
      "stellar:fee_prediction",
      10,
      JSON.stringify(parsed.data),
    );
  });

  it("classifies surge congestion and falls back to baseFee defaults when fee distributions are missing", async () => {
    feeStatsMock.mockResolvedValue({
      last_ledger: 999999,
      last_ledger_base_fee: 150,
      ledger_capacity_usage: 0.85,
    });

    const res = createResponse();
    await stellarFeePredictionHandler(createRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      data: {
        lastLedgerSequence: 999999,
        baseFeeStroops: 150,
        recommendations: {
          slow: 150,
          standard: 150,
          fast: 300,
        },
        congestionLevel: "surge",
        sampledLedgersCount: 100,
      },
      error: null,
    });
  });

  it("gracefully ignores Redis read/write failures and still returns Horizon prediction", async () => {
    redisGet.mockRejectedValue(new Error("Redis read unavailable"));
    redisSetex.mockRejectedValue(new Error("Redis write unavailable"));
    feeStatsMock.mockResolvedValue({
      last_ledger: 42,
      last_ledger_base_fee: 100,
      ledger_capacity_usage: 0.2,
      fee_charged: {
        p50: 80,
        p70: 90,
        p80: 110,
        p95: 250,
      },
    });

    const res = createResponse();
    await stellarFeePredictionHandler(createRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      data: {
        lastLedgerSequence: 42,
        baseFeeStroops: 100,
        recommendations: {
          slow: 100,
          standard: 100,
          fast: 250,
        },
        congestionLevel: "low",
        sampledLedgersCount: 100,
      },
      error: null,
    });
  });

  it("propagates upstream Horizon errors as 500 FEE_PREDICTION_ERROR", async () => {
    feeStatsMock.mockRejectedValue(new Error("Horizon 503 Service Unavailable"));

    const res = createResponse();
    await stellarFeePredictionHandler(createRequest(), res);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({
      data: null,
      error: {
        code: "FEE_PREDICTION_ERROR",
        message: "Horizon 503 Service Unavailable",
      },
    });
  });

  it("uses fallback error message when upstream Horizon error has no message", async () => {
    feeStatsMock.mockRejectedValue(new Error(""));

    const res = createResponse();
    await stellarFeePredictionHandler(createRequest(), res);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({
      data: null,
      error: {
        code: "FEE_PREDICTION_ERROR",
        message: "Failed to fetch fee prediction from Horizon",
      },
    });
  });
});
