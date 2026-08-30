import type { Redis } from "ioredis";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("notifications:dedup", process.env.LOG_LEVEL ?? "info");

export interface NotificationEvent {
  userId: string;
  category: string;
  type: string;
  identifier: string;
  payload: Record<string, unknown>;
}

export interface DeduplicationConfig {
  enabled: boolean;
  windowMs: number;
  keyGenerator: (event: NotificationEvent) => string;
  scope: "user" | "global" | "tenant";
  bypassCategories: string[];
}

export interface DeduplicationResult {
  allowed: boolean;
  reason: "new" | "duplicate" | "bypassed";
  existingNotificationId?: string;
  windowExpiresAt?: string;
}

export interface DeduplicationMetrics {
  totalChecks: number;
  duplicatesBlocked: number;
  bypassed: number;
  allowed: number;
  deduplicationRate: number;
}

const DEDUP_NS = "notif:dedup";
const METRICS_NS = "notif:dedup:metrics";

const DEFAULT_CONFIG: DeduplicationConfig = {
  enabled: true,
  windowMs: 300_000, // 5 minutes
  keyGenerator: (event) => `${event.userId}:${event.category}:${event.type}:${event.identifier}`,
  scope: "user",
  bypassCategories: ["security", "critical"],
};

export class NotificationDeduplicator {
  private readonly redis: Redis;
  private readonly config: DeduplicationConfig;
  private metrics: DeduplicationMetrics;

  constructor(redis: Redis, config?: Partial<DeduplicationConfig>) {
    this.redis = redis;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.metrics = {
      totalChecks: 0,
      duplicatesBlocked: 0,
      bypassed: 0,
      allowed: 0,
      deduplicationRate: 0,
    };
  }

  private generateKey(event: NotificationEvent): string {
    const scopePrefix = this.config.scope === "user" ? event.userId : this.config.scope;
    // For global/tenant scopes the userId must not be part of the key, so
    // two events from different users with the same identifier still collide.
    const keyEvent = this.config.scope === "user" ? event : { ...event, userId: "" };
    const baseKey = this.config.keyGenerator(keyEvent);
    return `${DEDUP_NS}:${scopePrefix}:${baseKey}`;
  }

  async check(event: NotificationEvent): Promise<DeduplicationResult> {
    this.metrics.totalChecks++;

    if (!this.config.enabled) {
      this.metrics.allowed++;
      return { allowed: true, reason: "new" };
    }

    if (this.config.bypassCategories.includes(event.category)) {
      this.metrics.bypassed++;
      log.debug("Bypassing deduplication for critical category", {
        category: event.category,
        userId: event.userId,
      });
      return { allowed: true, reason: "bypassed" };
    }

    const key = this.generateKey(event);
    const windowSeconds = Math.ceil(this.config.windowMs / 1000);

    try {
      const result = await this.redis.set(key, "1", "EX", windowSeconds, "NX");

      if (result === "OK") {
        this.metrics.allowed++;
        this.updateDeduplicationRate();
        return { allowed: true, reason: "new" };
      }

      const ttl = await this.redis.ttl(key);
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

      this.metrics.duplicatesBlocked++;
      this.updateDeduplicationRate();

      log.info("Duplicate notification blocked", {
        userId: event.userId,
        category: event.category,
        type: event.type,
        identifier: event.identifier,
        windowExpiresAt: expiresAt,
      });

      return {
        allowed: false,
        reason: "duplicate",
        windowExpiresAt: expiresAt,
      };
    } catch (err) {
      log.error("Deduplication check failed, allowing notification", {
        error: err instanceof Error ? err.message : String(err),
        userId: event.userId,
      });
      this.metrics.allowed++;
      return { allowed: true, reason: "new" };
    }
  }

  async checkBatch(events: NotificationEvent[]): Promise<DeduplicationResult[]> {
    if (!this.config.enabled || events.length === 0) {
      return events.map(() => ({ allowed: true, reason: "new" as const }));
    }

    const pipeline = this.redis.pipeline();
    const keys: string[] = [];
    const windowSeconds = Math.ceil(this.config.windowMs / 1000);

    for (const event of events) {
      if (this.config.bypassCategories.includes(event.category)) {
        keys.push("");
        continue;
      }
      const key = this.generateKey(event);
      keys.push(key);
      pipeline.set(key, "1", "EX", windowSeconds, "NX");
    }

    try {
      const results = await pipeline.exec();
      if (!results) {
        return events.map(() => ({ allowed: true, reason: "new" as const }));
      }

      const outcomes: DeduplicationResult[] = [];
      let pipelineIndex = 0;
      for (let index = 0; index < events.length; index++) {
        this.metrics.totalChecks++;

        if (keys[index] === "") {
          this.metrics.bypassed++;
          outcomes.push({ allowed: true, reason: "bypassed" as const });
          continue;
        }

        const [err, result] = results[pipelineIndex++];
        if (err) {
          log.error("Batch dedup check failed for item", {
            index,
            error: err instanceof Error ? err.message : String(err),
          });
          this.metrics.allowed++;
          outcomes.push({ allowed: true, reason: "new" as const });
          continue;
        }

        if (result === "OK") {
          this.metrics.allowed++;
          outcomes.push({ allowed: true, reason: "new" as const });
          continue;
        }

        this.metrics.duplicatesBlocked++;
        outcomes.push({ allowed: false, reason: "duplicate" as const });
      }
      return outcomes;
    } catch (err) {
      log.error("Batch deduplication check failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return events.map(() => ({ allowed: true, reason: "new" as const }));
    } finally {
      this.updateDeduplicationRate();
    }
  }

  async getMetrics(): Promise<DeduplicationMetrics> {
    this.updateDeduplicationRate();
    return { ...this.metrics };
  }

  async resetMetrics(): Promise<void> {
    this.metrics = {
      totalChecks: 0,
      duplicatesBlocked: 0,
      bypassed: 0,
      allowed: 0,
      deduplicationRate: 0,
    };
  }

  async storeMetrics(): Promise<void> {
    try {
      await this.redis.hset(METRICS_NS, {
        totalChecks: this.metrics.totalChecks.toString(),
        duplicatesBlocked: this.metrics.duplicatesBlocked.toString(),
        bypassed: this.metrics.bypassed.toString(),
        allowed: this.metrics.allowed.toString(),
        deduplicationRate: this.metrics.deduplicationRate.toString(),
        lastUpdated: new Date().toISOString(),
      });
    } catch (err) {
      log.error("Failed to store deduplication metrics", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async getStoredMetrics(): Promise<Record<string, string> | null> {
    try {
      return await this.redis.hgetall(METRICS_NS);
    } catch (err) {
      log.error("Failed to retrieve deduplication metrics", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private updateDeduplicationRate(): void {
    if (this.metrics.totalChecks > 0) {
      this.metrics.deduplicationRate =
        this.metrics.duplicatesBlocked / this.metrics.totalChecks;
    }
  }
}

export function createDefaultDeduplicator(redis: Redis): NotificationDeduplicator {
  return new NotificationDeduplicator(redis);
}

export function createDeduplicatorWithConfig(
  redis: Redis,
  config: Partial<DeduplicationConfig>
): NotificationDeduplicator {
  return new NotificationDeduplicator(redis, config);
}
