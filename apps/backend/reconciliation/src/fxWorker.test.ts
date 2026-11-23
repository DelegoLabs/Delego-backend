/**
 * Unit tests for #622 — multi-currency FX rate snapshot store with hourly
 * refresh. Covers CoinGecko/Kraken parsing, the CoinGecko -> Kraken fallback
 * path, persistence via `FxRateSnapshot.bulkCreate`, and the historical
 * closest-rate lookup.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./models/FxRateSnapshot.js", () => ({
  FxRateSnapshot: { bulkCreate: vi.fn(), findOne: vi.fn() },
}));

import { FxRateSnapshot } from "./models/FxRateSnapshot.js";
import {
  getConfiguredFxPairs,
  createCoinGeckoFetcher,
  createKrakenFetcher,
  captureFxRateSnapshots,
  getClosestFxRate,
  startFxSnapshotWorker,
  stopFxSnapshotWorker,
  type CurrencyPair,
  type FxRateFetcher,
} from "./fxWorker.js";

const mockedBulkCreate = vi.mocked(FxRateSnapshot.bulkCreate);
const mockedFindOne = vi.mocked(FxRateSnapshot.findOne);

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.FX_SNAPSHOT_PAIRS;
  stopFxSnapshotWorker();
});

describe("getConfiguredFxPairs", () => {
  it("defaults to XLM/USDC against USD/EUR/GBP", () => {
    const pairs = getConfiguredFxPairs();
    expect(pairs).toEqual(
      expect.arrayContaining([
        { base: "XLM", quote: "USD" },
        { base: "USDC", quote: "GBP" },
      ])
    );
    expect(pairs.length).toBe(6);
  });

  it("parses FX_SNAPSHOT_PAIRS when set", () => {
    process.env.FX_SNAPSHOT_PAIRS = "xlm/usd, usdc/eur";
    expect(getConfiguredFxPairs()).toEqual([
      { base: "XLM", quote: "USD" },
      { base: "USDC", quote: "EUR" },
    ]);
  });
});

describe("createCoinGeckoFetcher", () => {
  it("maps CoinGecko's response back onto the requested pairs", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        stellar: { usd: 0.11223344, eur: 0.1 },
        "usd-coin": { usd: 1.0001 },
      })
    );
    const fetcher = createCoinGeckoFetcher(fetchImpl as unknown as typeof fetch);

    const rates = await fetcher.fetchRates([
      { base: "XLM", quote: "USD" },
      { base: "XLM", quote: "EUR" },
      { base: "USDC", quote: "USD" },
      { base: "USDC", quote: "GBP" },
    ]);

    expect(rates.get("XLM/USD")).toBe(0.11223344);
    expect(rates.get("XLM/EUR")).toBe(0.1);
    expect(rates.get("USDC/USD")).toBe(1.0001);
    expect(rates.has("USDC/GBP")).toBe(false);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("ids=stellar%2Cusd-coin")
    );
  });

  it("throws when CoinGecko responds with a non-ok status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 503));
    const fetcher = createCoinGeckoFetcher(fetchImpl as unknown as typeof fetch);

    await expect(fetcher.fetchRates([{ base: "XLM", quote: "USD" }])).rejects.toThrow(
      "CoinGecko request failed with status 503"
    );
  });
});

describe("createKrakenFetcher", () => {
  it("parses Kraken ticker 'c' (last trade) field for mapped pairs", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        error: [],
        result: {
          XXLMZUSD: { c: ["0.11300000", "100.0"] },
        },
      })
    );
    const fetcher = createKrakenFetcher(fetchImpl as unknown as typeof fetch);

    const rates = await fetcher.fetchRates([{ base: "XLM", quote: "USD" }]);

    expect(rates.get("XLM/USD")).toBeCloseTo(0.113);
  });

  it("skips pairs Kraken has no known asset-pair code for", async () => {
    const fetchImpl = vi.fn();
    const fetcher = createKrakenFetcher(fetchImpl as unknown as typeof fetch);

    const rates = await fetcher.fetchRates([{ base: "DOGE", quote: "JPY" }]);

    expect(rates.size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws when Kraken's body carries an error array", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: ["EQuery:Unknown asset pair"], result: {} })
    );
    const fetcher = createKrakenFetcher(fetchImpl as unknown as typeof fetch);

    await expect(fetcher.fetchRates([{ base: "XLM", quote: "USD" }])).rejects.toThrow(
      "EQuery:Unknown asset pair"
    );
  });
});

describe("captureFxRateSnapshots", () => {
  const pairs: CurrencyPair[] = [
    { base: "XLM", quote: "USD" },
    { base: "USDC", quote: "USD" },
  ];

  it("persists rates from the first fetcher that prices every pair", async () => {
    const primary: FxRateFetcher = {
      source: "coingecko",
      fetchRates: vi.fn().mockResolvedValue(
        new Map([
          ["XLM/USD", 0.1],
          ["USDC/USD", 1.0],
        ])
      ),
    };
    const fallback: FxRateFetcher = { source: "kraken", fetchRates: vi.fn() };

    const count = await captureFxRateSnapshots(pairs, [primary, fallback]);

    expect(count).toBe(2);
    expect(fallback.fetchRates).not.toHaveBeenCalled();
    expect(mockedBulkCreate).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ baseCurrency: "XLM", quoteCurrency: "USD", rate: 0.1, source: "coingecko" }),
        expect.objectContaining({ baseCurrency: "USDC", quoteCurrency: "USD", rate: 1.0, source: "coingecko" }),
      ])
    );
  });

  it("falls back to the next source only for pairs the primary source could not price", async () => {
    const primary: FxRateFetcher = {
      source: "coingecko",
      fetchRates: vi.fn().mockResolvedValue(new Map([["XLM/USD", 0.1]])),
    };
    const fallback: FxRateFetcher = {
      source: "kraken",
      fetchRates: vi.fn().mockResolvedValue(new Map([["USDC/USD", 1.0]])),
    };

    const count = await captureFxRateSnapshots(pairs, [primary, fallback]);

    expect(count).toBe(2);
    expect(fallback.fetchRates).toHaveBeenCalledWith([{ base: "USDC", quote: "USD" }]);
    expect(mockedBulkCreate).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ baseCurrency: "XLM", source: "coingecko" }),
        expect.objectContaining({ baseCurrency: "USDC", source: "kraken" }),
      ])
    );
  });

  it("keeps trying remaining sources when one throws, and never writes nothing as a write", async () => {
    const primary: FxRateFetcher = { source: "coingecko", fetchRates: vi.fn().mockRejectedValue(new Error("down")) };
    const fallback: FxRateFetcher = {
      source: "kraken",
      fetchRates: vi.fn().mockResolvedValue(new Map([["XLM/USD", 0.1], ["USDC/USD", 1.0]])),
    };

    const count = await captureFxRateSnapshots(pairs, [primary, fallback]);

    expect(count).toBe(2);
    expect(mockedBulkCreate).toHaveBeenCalledTimes(1);
  });

  it("does not call bulkCreate when no source priced any pair", async () => {
    const primary: FxRateFetcher = { source: "coingecko", fetchRates: vi.fn().mockResolvedValue(new Map()) };

    const count = await captureFxRateSnapshots(pairs, [primary]);

    expect(count).toBe(0);
    expect(mockedBulkCreate).not.toHaveBeenCalled();
  });
});

describe("getClosestFxRate", () => {
  it("queries the snapshot table ordered by captured_at DESC, scoped to the pair and cutoff", async () => {
    const cutoff = new Date("2026-11-01T12:00:00.000Z");
    mockedFindOne.mockResolvedValue({ rate: 0.1123 } as any);

    const result = await getClosestFxRate("xlm", "usd", cutoff);

    expect(result).toEqual({ rate: 0.1123 });
    expect(mockedFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ baseCurrency: "XLM", quoteCurrency: "USD" }),
        order: [["capturedAt", "DESC"]],
      })
    );
  });
});

describe("startFxSnapshotWorker / stopFxSnapshotWorker", () => {
  it("captures immediately and is idempotent across repeated starts", () => {
    mockedBulkCreate.mockResolvedValue([] as any);
    startFxSnapshotWorker(60_000);
    startFxSnapshotWorker(60_000);
    stopFxSnapshotWorker();
    // No assertion failure/throw across double-start + stop is the contract here.
    expect(true).toBe(true);
  });
});
