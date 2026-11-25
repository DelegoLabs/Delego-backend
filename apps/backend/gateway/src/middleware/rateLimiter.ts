/**
 * Redis-backed sliding-window token-bucket rate limiter with tier quotas
 * (Issue #610).
 *
 * Distributed limiting per API key (preferred) or client IP, evaluated
 * atomically in Redis via a Lua script so concurrent gateway instances see a
 * consistent bucket state. Tokens refill continuously at `refillRatePerSecond`
 * up to `capacity` — a continuous-refill token bucket inherently behaves as a
 * sliding window (unlike a fixed-window counter, it never allows a burst of
 * `2x capacity` at a window boundary). Public/anonymous callers are capped at
 * 60 req/min; authenticated merchant tiers get higher capacity and refill
 * rates.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "@delegolabs/utils";
import { getRedisClient } from "../rateLimit/redisClient.js";
import { getAuthenticatedUserContext } from "../../middleware/auth.js";

export interface RateLimitTierConfig {
  tierName: "anonymous" | "standard_merchant" | "enterprise";
  capacity: number;
  refillRatePerSecond: number;
  windowSeconds: number;
}

export interface RateLimitStatus {
  allowed: boolean;
  remainingTokens: number;
  resetSeconds: number;
}

/** Default tier quotas. `anonymous` matches the 60 req/min public-endpoint cap. */
export const DEFAULT_TIER_CONFIGS: Record<RateLimitTierConfig["tierName"], RateLimitTierConfig> = {
  anonymous: { tierName: "anonymous", capacity: 60, refillRatePerSecond: 1, windowSeconds: 60 },
  standard_merchant: {
    tierName: "standard_merchant",
    capacity: 600,
    refillRatePerSecond: 10,
    windowSeconds: 60,
  },
  enterprise: {
    tierName: "enterprise",
    capacity: 3000,
    refillRatePerSecond: 50,
    windowSeconds: 60,
  },
};

/** Minimal subset of the ioredis client API this module depends on. */
export interface RateLimiterRedisClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

// Atomically refills the bucket based on elapsed time, then attempts to
// consume one token. Returns {allowed, tokensRemaining, resetSeconds}.
// `resetSeconds` is how long until the bucket is back at full capacity,
// which also bounds how long a throttled caller must wait for its next
// token (ceil'd so callers never retry a fraction of a second too early).
const SLIDING_WINDOW_TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerSecond = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local windowSeconds = tonumber(ARGV[4])

local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local ts = tonumber(bucket[2])

if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end

local elapsedSeconds = (now - ts) / 1000
if elapsedSeconds < 0 then
  elapsedSeconds = 0
end
tokens = math.min(capacity, tokens + elapsedSeconds * refillPerSecond)

local allowed = 0
if tokens >= 1 then
  allowed = 1
  tokens = tokens - 1
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', key, windowSeconds * 2)

local deficit = capacity - tokens
local resetSeconds = 0
if refillPerSecond > 0 then
  resetSeconds = math.ceil(deficit / refillPerSecond)
end

return {allowed, tostring(tokens), resetSeconds}
`;

export class SlidingWindowTokenBucketLimiter {
  constructor(private readonly redis: RateLimiterRedisClient) {}

  async check(identifier: string, tier: RateLimitTierConfig): Promise<RateLimitStatus> {
    const key = `ratelimit:tokenbucket:${tier.tierName}:${identifier}`;
    const now = Date.now();

    const raw = (await this.redis.eval(
      SLIDING_WINDOW_TOKEN_BUCKET_LUA,
      1,
      key,
      tier.capacity,
      tier.refillRatePerSecond,
      now,
      tier.windowSeconds,
    )) as [number, string, number];

    const [allowedFlag, tokensStr, resetSeconds] = raw;
    return {
      allowed: allowedFlag === 1,
      remainingTokens: Math.max(0, Math.floor(Number(tokensStr))),
      resetSeconds: Number(resetSeconds),
    };
  }
}

let defaultLimiter: SlidingWindowTokenBucketLimiter | null = null;

function getDefaultLimiter(): SlidingWindowTokenBucketLimiter {
  if (!defaultLimiter) {
    defaultLimiter = new SlidingWindowTokenBucketLimiter(
      getRedisClient() as unknown as RateLimiterRedisClient,
    );
  }
  return defaultLimiter;
}

function resolveIdentifier(req: IncomingMessage): { identifier: string; tier: RateLimitTierConfig } {
  const apiKey = req.headers["x-api-key"];
  const apiKeyValue = Array.isArray(apiKey) ? apiKey[0] : apiKey;

  if (apiKeyValue) {
    const ctx = getAuthenticatedUserContext(req);
    const roles = ctx?.roles ?? [];
    const tier = roles.includes("enterprise")
      ? DEFAULT_TIER_CONFIGS.enterprise
      : DEFAULT_TIER_CONFIGS.standard_merchant;
    return { identifier: `key:${apiKeyValue}`, tier };
  }

  const forwarded = req.headers["x-forwarded-for"];
  const forwardedIp = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0]?.trim();
  const ip = forwardedIp || req.socket.remoteAddress || "unknown";
  return { identifier: `ip:${ip}`, tier: DEFAULT_TIER_CONFIGS.anonymous };
}

export interface RateLimiterMiddlewareOptions {
  limiter?: SlidingWindowTokenBucketLimiter;
  tierConfigs?: Partial<Record<RateLimitTierConfig["tierName"], RateLimitTierConfig>>;
}

/**
 * Builds Express/Connect-style middleware enforcing the tiered token-bucket
 * limit, setting `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and
 * `X-RateLimit-Reset` on every response, plus `Retry-After` on a 429.
 */
export function rateLimiterMiddleware(options: RateLimiterMiddlewareOptions = {}) {
  const limiter = options.limiter ?? getDefaultLimiter();

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ): Promise<void> => {
    try {
      const { identifier, tier: resolvedTier } = resolveIdentifier(req);
      const tier = options.tierConfigs?.[resolvedTier.tierName] ?? resolvedTier;

      const status = await limiter.check(identifier, tier);

      res.setHeader("X-RateLimit-Limit", String(tier.capacity));
      res.setHeader("X-RateLimit-Remaining", String(status.remainingTokens));
      res.setHeader("X-RateLimit-Reset", String(status.resetSeconds));

      if (!status.allowed) {
        res.setHeader("Retry-After", String(status.resetSeconds));
        json(res, 429, {
          data: null,
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: `Rate limit exceeded for tier "${tier.tierName}". Please retry after ${status.resetSeconds} seconds.`,
          },
        });
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
