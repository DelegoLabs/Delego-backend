import { ExchangeRateCache } from "../models/ExchangeRateCache.js";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("reconciliation:exchange", process.env.LOG_LEVEL ?? "info");

/**
 * Exchange Rate Service - Handles multi-currency reconciliation
 */
export class ExchangeRateService {
  private apiUrl: string = process.env.EXCHANGE_RATE_API ?? "https://api.exchangerate.com/v1";

  /**
   * Get exchange rate for a currency pair
   */
  async getRate(from: string, to: string, date?: string): Promise<number> {
    const cache = await this.getRateFromCache(from, to, date);
    if (cache) return cache;

    const rate = await this.fetchRate(from, to, date);
    if (rate) {
      await this.cacheRate(from, to, rate, date);
    }
    return rate || 1;
  }

  /**
   * Get rate from cache
   */
  private async getRateFromCache(from: string, to: string, date?: string): Promise<number | null> {
    try {
      const query: any = {
        from_currency: from,
        to_currency: to,
      };

      if (date) {
        query.validFrom = { [ExchangeRateCache.sequelize!.Op.lte]: new Date(date) };
        query.validTo = { [ExchangeRateCache.sequelize!.Op.gte]: new Date(date) };
      } else {
        query.validTo = { [ExchangeRateCache.sequelize!.Op.or]: [null, { [ExchangeRateCache.sequelize!.Op.gte]: new Date() }] };
      }

      const cache = await ExchangeRateCache.findOne({
        where: query,
        order: [["valid_from", "DESC"]],
      });

      return cache?.rate || null;
    } catch (err) {
      log.warn("Failed to get rate from cache", { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /**
   * Fetch rate from external API
   */
  private async fetchRate(from: string, to: string, date?: string): Promise<number | null> {
    try {
      const url = new URL(this.apiUrl);
      url.searchParams.set("from", from);
      url.searchParams.set("to", to);
      if (date) url.searchParams.set("date", date);

      const response = await fetch(url.toString());
      if (!response.ok) {
        log.error("Failed to fetch exchange rate", { from, to, status: response.status });
        return null;
      }

      const data = await response.json();
      return data.rate || null;
    } catch (err) {
      log.error("Failed to fetch exchange rate", { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /**
   * Cache exchange rate
   */
  private async cacheRate(from: string, to: string, rate: number, date?: string): Promise<void> {
    try {
      const validFrom = date ? new Date(date) : new Date();
      const validTo = date ? undefined : new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      await ExchangeRateCache.create({
        fromCurrency: from,
        toCurrency: to,
        rate,
        source: "external_api",
        validFrom,
        validTo,
      });
    } catch (err) {
      log.warn("Failed to cache exchange rate", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Convert amount between currencies
   */
  async convertAmount(amount: string, from: string, to: string, date?: string): Promise<number> {
    if (from === to) return parseFloat(amount);

    const rate = await this.getRate(from, to, date);
    return parseFloat(amount) * rate;
  }

  /**
   * Get all rates for a date
   */
  async getRatesForDate(date: string): Promise<Array<{ from: string; to: string; rate: number }>> {
    const rates = await ExchangeRateCache.findAll({
      where: {
        validFrom: { [ExchangeRateCache.sequelize!.Op.lte]: new Date(date) },
        validTo: { [ExchangeRateCache.sequelize!.Op.or]: [null, { [ExchangeRateCache.sequelize!.Op.gte]: new Date(date) }] },
      },
    });

    return rates.map((r) => ({
      from: r.fromCurrency,
      to: r.toCurrency,
      rate: r.rate,
    }));
  }

  /**
   * Refresh all expired rates
   */
  async refreshExpiredRates(): Promise<void> {
    try {
      const expired = await ExchangeRateCache.findAll({
        where: {
          validTo: { [ExchangeRateCache.sequelize!.Op.lt]: new Date() },
        },
      });

      for (const rate of expired) {
        await this.fetchRate(rate.fromCurrency, rate.toCurrency);
      }
    } catch (err) {
      log.error("Failed to refresh expired rates", { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

export const exchangeRateService = new ExchangeRateService();
