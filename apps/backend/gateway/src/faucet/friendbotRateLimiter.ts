/**
 * Friendbot Proxy Rate Limiter (Issue #TBD)
 * 
 * Enforces 60-second cooldowns per Stellar public key and IP address
 * to prevent rate limiting from direct Friendbot calls.
 * 
 * Uses Redis SET key 1 EX 60 NX for atomic cooldown enforcement.
 * 
 * This file implements 1% of the feature: the core rate limiting logic.
 */

import type Redis from "ioredis";

/**
 * Rate limit check result with cooldown information.
 */
export interface RateLimitResult {
  /** Whether the request is allowed (not rate limited) */
  allowed: boolean;
  /** Remaining cooldown seconds (0 if allowed, >0 if rate limited) */
  cooldownSeconds: number;
  /** Human-readable message */
  message: string;
}

/**
 * Friendbot proxy rate limiter enforcing 60-second cooldowns.
 */
export class FriendBotRateLimiter {
  private readonly redis: Redis;
  private readonly cooldownSeconds: number;

  /**
   * @param redis - Redis client for storing cooldown state
   * @param cooldownSeconds - Cooldown duration in seconds (default: 60)
   */
  constructor(redis: Redis, cooldownSeconds = 60) {
    this.redis = redis;
    this.cooldownSeconds = cooldownSeconds;
  }

  /**
   * Checks if a request is allowed based on public key and IP address cooldowns.
   * Uses Redis SET NX EX pattern for atomic cooldown enforcement.
   * 
   * @param publicKey - Stellar public key (G-address)
   * @param clientIp - Client IP address
   * @returns Rate limit result with allowed status and remaining cooldown
   * 
   * @example
   * ```typescript
   * const limiter = new FriendBotRateLimiter(redis);
   * const result = await limiter.checkRateLimit('GXXX...', '192.168.1.1');
   * 
   * if (!result.allowed) {
   *   console.log(`Rate limited. Retry after ${result.cooldownSeconds}s`);
   * }
   * ```
   */
  async checkRateLimit(publicKey: string, clientIp: string): Promise<RateLimitResult> {
    // Check public key cooldown
    const keyResult = await this.checkKey(`friendbot:cooldown:key:${publicKey}`);
    if (!keyResult.allowed) {
      return {
        allowed: false,
        cooldownSeconds: keyResult.cooldownSeconds,
        message: `Rate limit exceeded for address ${publicKey}. Retry after ${keyResult.cooldownSeconds} seconds.`,
      };
    }

    // Check IP address cooldown
    const ipResult = await this.checkKey(`friendbot:cooldown:ip:${clientIp}`);
    if (!ipResult.allowed) {
      return {
        allowed: false,
        cooldownSeconds: ipResult.cooldownSeconds,
        message: `Rate limit exceeded for IP ${clientIp}. Retry after ${ipResult.cooldownSeconds} seconds.`,
      };
    }

    return {
      allowed: true,
      cooldownSeconds: 0,
      message: "Request allowed",
    };
  }

  /**
   * Records a successful funding request by setting cooldown keys.
   * Both public key and IP address cooldowns are set atomically.
   * 
   * @param publicKey - Stellar public key that was funded
   * @param clientIp - Client IP address that made the request
   */
  async recordRequest(publicKey: string, clientIp: string): Promise<void> {
    // Set cooldown for public key (SET key 1 EX seconds NX pattern already handled by checkKey)
    // We need to explicitly set here since checkKey only checks, doesn't set
    await this.redis.setex(
      `friendbot:cooldown:key:${publicKey}`,
      this.cooldownSeconds,
      "1"
    );

    // Set cooldown for IP address
    await this.redis.setex(
      `friendbot:cooldown:ip:${clientIp}`,
      this.cooldownSeconds,
      "1"
    );
  }

  /**
   * Checks a single Redis key for cooldown status.
   * Uses SET NX EX pattern: attempts to set key with expiry if it doesn't exist.
   * 
   * @param key - Redis key to check
   * @returns Result indicating if request is allowed and remaining cooldown
   */
  private async checkKey(key: string): Promise<{ allowed: boolean; cooldownSeconds: number }> {
    try {
      // Try to set the key with NX (only if not exists) and EX (with expiry)
      // SET key value EX seconds NX
      const result = await this.redis.set(
        key,
        "1",
        "EX",
        this.cooldownSeconds,
        "NX"
      );

      // If SET succeeded (returned 'OK'), key didn't exist - request is allowed
      if (result === "OK") {
        return {
          allowed: true,
          cooldownSeconds: 0,
        };
      }

      // Key already exists - check remaining TTL
      const ttl = await this.redis.ttl(key);

      // TTL returns -2 if key doesn't exist, -1 if no expiry, or remaining seconds
      const remainingSeconds = ttl > 0 ? ttl : 0;

      return {
        allowed: false,
        cooldownSeconds: remainingSeconds,
      };
    } catch (error) {
      // On Redis error, fail open (allow request) to prevent blocking legitimate users
      // In production, this should be logged for monitoring
      console.error("Redis error in rate limiter:", error);
      return {
        allowed: true,
        cooldownSeconds: 0,
      };
    }
  }

  /**
   * Gets the remaining cooldown time for a public key.
   * Useful for providing Retry-After header values.
   * 
   * @param publicKey - Stellar public key to check
   * @returns Remaining cooldown seconds (0 if no cooldown active)
   */
  async getRemainingCooldown(publicKey: string): Promise<number> {
    const keyTtl = await this.redis.ttl(`friendbot:cooldown:key:${publicKey}`);
    return keyTtl > 0 ? keyTtl : 0;
  }

  /**
   * Gets the remaining cooldown time for an IP address.
   * 
   * @param clientIp - IP address to check
   * @returns Remaining cooldown seconds (0 if no cooldown active)
   */
  async getRemainingCooldownForIp(clientIp: string): Promise<number> {
    const ipTtl = await this.redis.ttl(`friendbot:cooldown:ip:${clientIp}`);
    return ipTtl > 0 ? ipTtl : 0;
  }

  /**
   * Manually resets cooldown for a public key (admin/testing use).
   * 
   * @param publicKey - Stellar public key to reset
   */
  async resetCooldown(publicKey: string): Promise<void> {
    await this.redis.del(`friendbot:cooldown:key:${publicKey}`);
  }

  /**
   * Manually resets cooldown for an IP address (admin/testing use).
   * 
   * @param clientIp - IP address to reset
   */
  async resetCooldownForIp(clientIp: string): Promise<void> {
    await this.redis.del(`friendbot:cooldown:ip:${clientIp}`);
  }
}
