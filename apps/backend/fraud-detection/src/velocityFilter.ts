/**
 * Anti-Sybil velocity filter flagging subnet checkout spikes (Issue #612).
 *
 * Bots that rotate through IP addresses within the same /24 IPv4 or /48
 * IPv6 block to drain promotional discounts or test stolen cards still
 * share that block. This filter groups checkout attempts by subnet (not
 * individual IP) in a Redis sorted set, scored by timestamp, and flags a
 * subnet once it exceeds `maxCheckoutsPerSubnetPerMinute` attempts within a
 * trailing 60-second window — mirroring the sliding-window approach
 * `../../fraud-detection/src/services/escrowVelocityService.ts` and
 * `packages/utils/src/rateLimit/slidingWindowRateLimiter.ts` already use
 * elsewhere in this codebase, applied to subnets instead of accounts.
 *
 * A single isolated buyer never shares a /24 or /48 with 20 other
 * attempts in a minute under normal traffic, so this does not impact
 * legitimate isolated buyers (Issue #612's acceptance criteria).
 */
import { randomUUID } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import Redis from "ioredis";

export interface SubnetVelocityConfig {
  maxCheckoutsPerSubnetPerMinute: number;
  blockDurationSeconds: number;
}

export const DEFAULT_SUBNET_VELOCITY_CONFIG: SubnetVelocityConfig = {
  maxCheckoutsPerSubnetPerMinute: 20,
  blockDurationSeconds: 15 * 60,
};

export interface VelocityCheckResult {
  blocked: boolean;
  subnet: string;
  currentCount: number;
  expiresInSeconds?: number;
}

const WINDOW_MS = 60 * 1000;
const KEY_PREFIX = "fraud:subnet-velocity";
const BLOCK_PREFIX = "fraud:subnet-blocked";

function stripIPv4MappedPrefix(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/**
 * Derives the containing /24 (IPv4) or /48 (IPv6) subnet identifier for an
 * IP address — the granularity bots rotate within but can't cheaply escape.
 * Returns null for an unparseable address (treated as "no subnet grouping
 * possible," which callers should fail open on rather than block).
 */
export function getSubnetForIp(ip: string): string | null {
  const normalized = stripIPv4MappedPrefix(ip.trim());

  if (isIPv4(normalized)) {
    const octets = normalized.split(".");
    if (octets.length !== 4) return null;
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }

  if (isIPv6(normalized)) {
    // Expand "::" compression so the first 3 groups (48 bits) are unambiguous.
    let groups: string[];
    if (normalized.includes("::")) {
      const [head, tail] = normalized.split("::");
      const headParts = head ? head.split(":") : [];
      const tailParts = tail ? tail.split(":") : [];
      const missing = 8 - headParts.length - tailParts.length;
      if (missing < 0) return null;
      groups = [...headParts, ...Array(missing).fill("0"), ...tailParts];
    } else {
      groups = normalized.split(":");
    }
    if (groups.length !== 8) return null;
    return `${groups[0]}:${groups[1]}:${groups[2]}::/48`;
  }

  return null;
}

/** Minimal ioredis-compatible subset this module depends on. */
export interface SubnetVelocityRedisClient {
  multi(): {
    zadd(key: string, score: number, member: string): unknown;
    zremrangebyscore(key: string, min: number | string, max: number | string): unknown;
    expire(key: string, seconds: number): unknown;
    exec(): Promise<unknown>;
  };
  zcount(key: string, min: number | string, max: number | string): Promise<number>;
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number>;
  set(key: string, value: string | number, ...args: Array<string | number>): Promise<"OK" | null>;
  exists(key: string): Promise<number>;
  ttl(key: string): Promise<number>;
  del(key: string): Promise<number>;
}

type SubnetVelocityRedisMulti = ReturnType<SubnetVelocityRedisClient["multi"]>;

function isSubnetVelocityRedisMulti(value: unknown): value is SubnetVelocityRedisMulti {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.zadd === "function" &&
    typeof candidate.zremrangebyscore === "function" &&
    typeof candidate.expire === "function" &&
    typeof candidate.exec === "function"
  );
}

export class SubnetVelocityFilter {
  private readonly redis: SubnetVelocityRedisClient;
  private readonly config: SubnetVelocityConfig;

  constructor(
    redis?: SubnetVelocityRedisClient,
    config: Partial<SubnetVelocityConfig> = {}
  ) {
    this.redis = redis ?? (new Redis(process.env.REDIS_URL ?? "redis://localhost:6379") as unknown as SubnetVelocityRedisClient);
    this.config = { ...DEFAULT_SUBNET_VELOCITY_CONFIG, ...config };
  }

  /**
   * Records one checkout attempt from `ip` and returns the up-to-date
   * velocity check for its subnet, flagging (and blocking) it if the
   * trailing-60-second count now exceeds the configured threshold.
   */
  async recordAndCheck(ip: string): Promise<VelocityCheckResult> {
    const subnet = getSubnetForIp(ip);
    if (!subnet) {
      // Unparseable address: fail open rather than block on a grouping we
      // can't compute — this filter targets subnet rotation, not malformed input.
      return { blocked: false, subnet: "unknown", currentCount: 0 };
    }

    if (await this.isBlocked(subnet)) {
      const expiresInSeconds = await this.redis.ttl(this.getBlockKey(subnet));
      return {
        blocked: true,
        subnet,
        currentCount: this.config.maxCheckoutsPerSubnetPerMinute,
        expiresInSeconds: expiresInSeconds > 0 ? expiresInSeconds : this.config.blockDurationSeconds,
      };
    }

    const key = this.getKey(subnet);
    const now = Date.now();
    const windowStart = now - WINDOW_MS;
    const member = `${now}:${randomUUID()}`;

    const pipeline = this.redis.multi();
    const afterZadd = pipeline.zadd(key, now, member);
    const step2 = isSubnetVelocityRedisMulti(afterZadd) ? afterZadd : pipeline;
    const afterZrem = step2.zremrangebyscore(key, 0, windowStart);
    const step3 = isSubnetVelocityRedisMulti(afterZrem) ? afterZrem : step2;
    const afterExpire = step3.expire(key, Math.ceil(WINDOW_MS / 1000) * 2);
    const finalPipeline = isSubnetVelocityRedisMulti(afterExpire) ? afterExpire : step3;
    await finalPipeline.exec();

    const currentCount = await this.redis.zcount(key, windowStart, now);

    if (currentCount > this.config.maxCheckoutsPerSubnetPerMinute) {
      await this.block(subnet);
      return {
        blocked: true,
        subnet,
        currentCount,
        expiresInSeconds: this.config.blockDurationSeconds,
      };
    }

    return { blocked: false, subnet, currentCount };
  }

  async isBlocked(subnet: string): Promise<boolean> {
    return (await this.redis.exists(this.getBlockKey(subnet))) === 1;
  }

  async block(subnet: string): Promise<void> {
    await this.redis.set(this.getBlockKey(subnet), "1", "EX", this.config.blockDurationSeconds);
  }

  async clearBlock(subnet: string): Promise<void> {
    await this.redis.del(this.getBlockKey(subnet));
  }

  private getKey(subnet: string): string {
    return `${KEY_PREFIX}:${subnet}`;
  }

  private getBlockKey(subnet: string): string {
    return `${BLOCK_PREFIX}:${subnet}`;
  }
}

/**
 * Whether a checkout from a flagged subnet should be stepped up with
 * CAPTCHA or biometric re-authentication (Issue #612's "Flag suspicious
 * activity and require CAPTCHA or biometric re-authentication") rather than
 * outright rejected — a blocked subnet still lets a genuine buyer through
 * if they can clear the extra challenge.
 */
export function requiresStepUpVerification(result: VelocityCheckResult): boolean {
  return result.blocked;
}
