/**
 * Multi-currency FX rate snapshot worker (Issue #622).
 *
 * Captures the exchange rate of each configured currency pair once an hour
 * and archives it permanently in `fx_rate_snapshots` — the audit trail tax
 * and compliance reviews rely on to reconstruct the fiat value of XLM/USDC
 * at the exact moment of a past order settlement. This is deliberately a
 * separate, append-only store from `ExchangeRateCache` (`exchangeRateService`),
 * which is a short-lived (24h TTL) cache used for live conversion, not audit.
 */
import { Op } from "sequelize";
import { createLogger } from "@delegolabs/utils";
import { FxRateSnapshot } from "./models/FxRateSnapshot.js";

const log = createLogger("reconciliation:fx-worker", process.env.LOG_LEVEL ?? "info");

export interface CurrencyPair {
  base: string;
  quote: string;
}

const DEFAULT_PAIRS: readonly CurrencyPair[] = [
  { base: "XLM", quote: "USD" },
  { base: "XLM", quote: "EUR" },
  { base: "XLM", quote: "GBP" },
  { base: "USDC", quote: "USD" },
  { base: "USDC", quote: "EUR" },
  { base: "USDC", quote: "GBP" },
];

/** Pairs snapshotted hourly; override via `FX_SNAPSHOT_PAIRS="XLM/USD,XLM/EUR,..."`. */
export function getConfiguredFxPairs(): CurrencyPair[] {
  const raw = process.env.FX_SNAPSHOT_PAIRS;
  if (!raw) return [...DEFAULT_PAIRS];

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [base, quote] = entry.split("/");
      return { base: (base ?? "").toUpperCase(), quote: (quote ?? "").toUpperCase() };
    })
    .filter((pair) => pair.base && pair.quote);
}

function pairKey(base: string, quote: string): string {
  return `${base}/${quote}`;
}

/** One FX rate data source, tried in order until every requested pair is priced. */
export interface FxRateFetcher {
  source: string;
  fetchRates(pairs: CurrencyPair[]): Promise<Map<string, number>>;
}

const COINGECKO_IDS: Record<string, string> = {
  XLM: "stellar",
  USDC: "usd-coin",
};

/** Primary source: CoinGecko's public `simple/price` endpoint. */
export function createCoinGeckoFetcher(fetchImpl: typeof fetch = fetch): FxRateFetcher {
  return {
    source: "coingecko",
    async fetchRates(pairs) {
      const ids = Array.from(
        new Set(pairs.map((pair) => COINGECKO_IDS[pair.base]).filter((id): id is string => Boolean(id)))
      );
      const vsCurrencies = Array.from(new Set(pairs.map((pair) => pair.quote.toLowerCase())));
      if (ids.length === 0 || vsCurrencies.length === 0) return new Map();

      const url = new URL("https://api.coingecko.com/api/v3/simple/price");
      url.searchParams.set("ids", ids.join(","));
      url.searchParams.set("vs_currencies", vsCurrencies.join(","));

      const response = await fetchImpl(url.toString());
      if (!response.ok) {
        throw new Error(`CoinGecko request failed with status ${response.status}`);
      }

      const body = (await response.json()) as Record<string, Record<string, number>>;
      const rates = new Map<string, number>();
      for (const pair of pairs) {
        const geckoId = COINGECKO_IDS[pair.base];
        const value = geckoId ? body[geckoId]?.[pair.quote.toLowerCase()] : undefined;
        if (typeof value === "number" && Number.isFinite(value)) {
          rates.set(pairKey(pair.base, pair.quote), value);
        }
      }
      return rates;
    },
  };
}

const KRAKEN_BASE_CODES: Record<string, string> = {
  XLM: "XXLM",
  USDC: "USDC",
};

const KRAKEN_QUOTE_CODES: Record<string, string> = {
  USD: "ZUSD",
  EUR: "ZEUR",
  GBP: "ZGBP",
};

function findKrakenResult(
  result: Record<string, { c?: [string, string] }> | undefined,
  requestedPair: string
): { c?: [string, string] } | undefined {
  if (!result) return undefined;
  if (result[requestedPair]) return result[requestedPair];
  // Kraken occasionally echoes back a differently-cased/prefixed asset pair
  // name than requested (asset naming is generated server-side); fall back
  // to a case-insensitive match so legitimate renames still resolve.
  const normalized = requestedPair.toUpperCase();
  const match = Object.keys(result).find((key) => key.toUpperCase() === normalized);
  return match ? result[match] : undefined;
}

/** Fallback source: Kraken's public `Ticker` endpoint, used when CoinGecko is unavailable. */
export function createKrakenFetcher(fetchImpl: typeof fetch = fetch): FxRateFetcher {
  return {
    source: "kraken",
    async fetchRates(pairs) {
      const krakenPairsByKey = new Map<string, string>();
      for (const pair of pairs) {
        const base = KRAKEN_BASE_CODES[pair.base];
        const quote = KRAKEN_QUOTE_CODES[pair.quote];
        if (base && quote) krakenPairsByKey.set(`${base}${quote}`, pairKey(pair.base, pair.quote));
      }
      if (krakenPairsByKey.size === 0) return new Map();

      const url = new URL("https://api.kraken.com/0/public/Ticker");
      url.searchParams.set("pair", Array.from(krakenPairsByKey.keys()).join(","));

      const response = await fetchImpl(url.toString());
      if (!response.ok) {
        throw new Error(`Kraken request failed with status ${response.status}`);
      }

      const body = (await response.json()) as {
        error?: string[];
        result?: Record<string, { c?: [string, string] }>;
      };
      if (body.error && body.error.length > 0) {
        throw new Error(`Kraken error: ${body.error.join(", ")}`);
      }

      const rates = new Map<string, number>();
      for (const [krakenPair, resultKey] of krakenPairsByKey) {
        const ticker = findKrakenResult(body.result, krakenPair);
        const last = ticker?.c?.[0];
        const value = last !== undefined ? Number(last) : NaN;
        if (Number.isFinite(value)) {
          rates.set(resultKey, value);
        }
      }
      return rates;
    },
  };
}

/**
 * Capture one hourly snapshot for every configured currency pair: tries each
 * fetcher in order (CoinGecko, then Kraken) and only falls through to the
 * next source for pairs the previous one couldn't price, so a partial outage
 * at the primary source doesn't block pairs it *did* successfully quote.
 */
export async function captureFxRateSnapshots(
  pairs: CurrencyPair[] = getConfiguredFxPairs(),
  fetchers: FxRateFetcher[] = [createCoinGeckoFetcher(), createKrakenFetcher()]
): Promise<number> {
  const resolved = new Map<string, { rate: number; source: string }>();
  let remaining = pairs;

  for (const fetcher of fetchers) {
    if (remaining.length === 0) break;
    try {
      const rates = await fetcher.fetchRates(remaining);
      for (const pair of remaining) {
        const key = pairKey(pair.base, pair.quote);
        const rate = rates.get(key);
        if (rate !== undefined) {
          resolved.set(key, { rate, source: fetcher.source });
        }
      }
      remaining = remaining.filter((pair) => !resolved.has(pairKey(pair.base, pair.quote)));
    } catch (err) {
      log.warn("FX rate source failed, trying next fallback", {
        source: fetcher.source,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (remaining.length > 0) {
    log.error("Failed to capture FX rate snapshot for some pairs", {
      pairs: remaining.map((pair) => pairKey(pair.base, pair.quote)),
    });
  }

  if (resolved.size === 0) return 0;

  const capturedAt = new Date();
  await FxRateSnapshot.bulkCreate(
    Array.from(resolved.entries()).map(([key, { rate, source }]) => {
      const [baseCurrency, quoteCurrency] = key.split("/");
      return { baseCurrency, quoteCurrency, rate, source, capturedAt };
    })
  );

  log.info("Captured FX rate snapshots", { count: resolved.size, capturedAt: capturedAt.toISOString() });
  return resolved.size;
}

/**
 * Historical rate lookup: the snapshot captured at or before `atOrBefore`
 * (default now) closest to that timestamp — e.g. to reconstruct the fiat
 * value of a settlement that happened in the past. Served by
 * `idx_fx_snapshots_currencies_time` (base_currency, quote_currency,
 * captured_at DESC), which lets Postgres satisfy this as an index-only
 * "first matching row" scan, comfortably under the < 1ms latency target.
 */
export async function getClosestFxRate(
  baseCurrency: string,
  quoteCurrency: string,
  atOrBefore: Date = new Date()
): Promise<FxRateSnapshot | null> {
  return FxRateSnapshot.findOne({
    where: {
      baseCurrency: baseCurrency.toUpperCase(),
      quoteCurrency: quoteCurrency.toUpperCase(),
      capturedAt: { [Op.lte]: atOrBefore },
    },
    order: [["capturedAt", "DESC"]],
  });
}

const HOUR_MS = 60 * 60 * 1000;
let workerHandle: NodeJS.Timeout | undefined;

/**
 * Start the hourly FX snapshot capture loop: captures once immediately (so a
 * freshly-deployed instance doesn't wait up to an hour for its first
 * snapshot), then every `intervalMs` (default 1 hour) thereafter.
 */
export function startFxSnapshotWorker(intervalMs: number = HOUR_MS): void {
  if (workerHandle) return;

  void captureFxRateSnapshots().catch((err) =>
    log.error("Initial FX rate snapshot capture failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  );

  workerHandle = setInterval(() => {
    void captureFxRateSnapshots().catch((err) =>
      log.error("Scheduled FX rate snapshot capture failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    );
  }, intervalMs);
  workerHandle.unref?.();
}

/** Stop the hourly capture loop (used on graceful shutdown and in tests). */
export function stopFxSnapshotWorker(): void {
  if (workerHandle) {
    clearInterval(workerHandle);
    workerHandle = undefined;
  }
}
