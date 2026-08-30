import { Redis } from "ioredis";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("fraud-detection:features", process.env.LOG_LEVEL ?? "info");

/**
 * Feature Store - Manages real-time transaction features for scoring
 */
export class FeatureStore {
  private redis: Redis;
  private prefix: string = "fraud:features:";

  constructor(redisUrl: string = process.env.REDIS_URL ?? "redis://localhost:6379") {
    this.redis = new Redis(redisUrl);
    this.redis.on("error", (err) => log.error("Redis error", { error: err.message }));
  }

  /**
   * Get velocity features for a customer
   */
  async getCustomerVelocity(customerId: string, windowMinutes: number = 60): Promise<{
    transactionCount: number;
    totalAmount: number;
    distinctMerchants: number;
    distinctCards: number;
  }> {
    const key = `${this.prefix}velocity:${customerId}`;
    const now = Date.now();
    const windowMs = windowMinutes * 60 * 1000;
    const cutoff = now - windowMs;

    try {
      // Get transaction count in window
      const count = await this.redis.zcount(key, cutoff, now);
      // Get total amount
      const totalAmount = await this.redis.get(`${key}:amount`) || "0";
      // Get distinct merchants
      const merchants = await this.redis.scard(`${key}:merchants`);
      // Get distinct cards
      const cards = await this.redis.scard(`${key}:cards`);

      return {
        transactionCount: parseInt(count as string, 10),
        totalAmount: parseFloat(totalAmount),
        distinctMerchants: parseInt(merchants as string, 10),
        distinctCards: parseInt(cards as string, 10),
      };
    } catch (err) {
      log.warn("Failed to get velocity features", { error: err instanceof Error ? err.message : String(err) });
      return { transactionCount: 0, totalAmount: 0, distinctMerchants: 0, distinctCards: 0 };
    }
  }

  /**
   * Get velocity features for an IP address
   */
  async getIPVelocity(ipAddress: string, windowMinutes: number = 60): Promise<{
    transactionCount: number;
    distinctCustomers: number;
    flaggedCount: number;
  }> {
    const key = `${this.prefix}velocity:ip:${ipAddress}`;
    const now = Date.now();
    const windowMs = windowMinutes * 60 * 1000;
    const cutoff = now - windowMs;

    try {
      const count = await this.redis.zcount(key, cutoff, now);
      const customers = await this.redis.scard(`${key}:customers`);
      const flagged = await this.redis.zcount(`${key}:flagged`, cutoff, now);

      return {
        transactionCount: parseInt(count as string, 10),
        distinctCustomers: parseInt(customers as string, 10),
        flaggedCount: parseInt(flagged as string, 10),
      };
    } catch (err) {
      log.warn("Failed to get IP velocity", { error: err instanceof Error ? err.message : String(err) });
      return { transactionCount: 0, distinctCustomers: 0, flaggedCount: 0 };
    }
  }

  /**
   * Get velocity features for an email
   */
  async getEmailVelocity(email: string, windowMinutes: number = 60): Promise<{
    transactionCount: number;
    distinctAccounts: number;
  }> {
    const key = `${this.prefix}velocity:email:${this.normalizeEmail(email)}`;
    const now = Date.now();
    const windowMs = windowMinutes * 60 * 1000;
    const cutoff = now - windowMs;

    try {
      const count = await this.redis.zcount(key, cutoff, now);
      const accounts = await this.redis.scard(`${key}:accounts`);

      return {
        transactionCount: parseInt(count as string, 10),
        distinctAccounts: parseInt(accounts as string, 10),
      };
    } catch (err) {
      log.warn("Failed to get email velocity", { error: err instanceof Error ? err.message : String(err) });
      return { transactionCount: 0, distinctAccounts: 0 };
    }
  }

  /**
   * Store transaction feature for velocity tracking
   */
  async storeTransactionFeature(
    customerId: string,
    ipAddress: string,
    email: string,
    merchantId: string,
    cardLast4: string,
    amount: number,
    isFlagged: boolean = false,
  ): Promise<void> {
    const now = Date.now();
    const timestamp = now / 1000;

    const emailKey = this.normalizeEmail(email);

    try {
      // Customer velocity
      await this.redis.zadd(`${this.prefix}velocity:${customerId}`, timestamp, `${now}:${merchantId}`);
      await this.redis.sadd(`${this.prefix}velocity:${customerId}:merchants`, merchantId);
      await this.redis.sadd(`${this.prefix}velocity:${customerId}:cards`, cardLast4);
      await this.redis.incrbyfloat(`${this.prefix}velocity:${customerId}:amount`, amount);

      // IP velocity
      await this.redis.zadd(`${this.prefix}velocity:ip:${ipAddress}`, timestamp, `${now}:${customerId}`);
      await this.redis.sadd(`${this.prefix}velocity:ip:${ipAddress}:customers`, customerId);
      if (isFlagged) {
        await this.redis.zadd(`${this.prefix}velocity:ip:${ipAddress}:flagged`, timestamp, `${now}:${customerId}`);
      }

      // Email velocity
      await this.redis.zadd(`${this.prefix}velocity:email:${emailKey}`, timestamp, `${now}:${customerId}`);
      await this.redis.sadd(`${this.prefix}velocity:email:${emailKey}:accounts`, customerId);
    } catch (err) {
      log.error("Failed to store transaction features", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Get device history
   */
  async getDeviceHistory(fingerprint: string): Promise<{
    totalTransactions: number;
    flaggedTransactions: number;
    isFlagged: boolean;
  }> {
    const key = `${this.prefix}device:${fingerprint}`;
    try {
      const total = await this.redis.get(`${key}:total`);
      const flagged = await this.redis.get(`${key}:flagged`);

      return {
        totalTransactions: parseInt(total || "0", 10),
        flaggedTransactions: parseInt(flagged || "0", 10),
        isFlagged: await this.redis.get(`${key}:flagged`) === "true",
      };
    } catch (err) {
      log.warn("Failed to get device history", { error: err instanceof Error ? err.message : String(err) });
      return { totalTransactions: 0, flaggedTransactions: 0, isFlagged: false };
    }
  }

  /**
   * Store device fingerprint
   */
  async storeDeviceFingerprint(
    fingerprint: string,
    customerId: string,
    deviceType: string,
    browser: string,
    os: string,
  ): Promise<void> {
    try {
      await this.redis.setex(
        `${this.prefix}device:${fingerprint}`,
        30 * 24 * 60 * 60, // 30 days
        JSON.stringify({ customerId, deviceType, browser, os, createdAt: new Date().toISOString() }),
      );
    } catch (err) {
      log.error("Failed to store device fingerprint", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Get fraud rate for a region
   */
  async getRegionFraudRate(country: string, windowDays: number = 7): Promise<number> {
    const key = `${this.prefix}region:${country}`;
    const now = Date.now();
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    const cutoff = now - windowMs;

    try {
      const total = await this.redis.zcount(`${key}:transactions`, cutoff, now);
      const flagged = await this.redis.zcount(`${key}:flagged`, cutoff, now);

      return total > 0 ? flagged / total : 0;
    } catch (err) {
      log.warn("Failed to get region fraud rate", { error: err instanceof Error ? err.message : String(err) });
      return 0;
    }
  }

  /**
   * Store region fraud data
   */
  async storeRegionFraudData(country: string, isFlagged: boolean): Promise<void> {
    try {
      const now = Date.now();
      const timestamp = now / 1000;
      await this.redis.zadd(`${this.prefix}region:${country}:transactions`, timestamp, `${now}`);
      if (isFlagged) {
        await this.redis.zadd(`${this.prefix}region:${country}:flagged`, timestamp, `${now}`);
      }
    } catch (err) {
      log.error("Failed to store region fraud data", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Normalize email for consistent hashing
   */
  private normalizeEmail(email: string): string {
    return email.toLowerCase().replace(/\s+/g, "");
  }

  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    await this.redis.quit();
  }
}
