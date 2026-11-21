/**
 * Unit tests for Friendbot Proxy Rate Limiter
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { FriendBotRateLimiter } from "./friendbotRateLimiter.js";

describe("FriendBotRateLimiter", () => {
  let mockRedis: any;
  let rateLimiter: FriendBotRateLimiter;

  const TEST_PUBLIC_KEY = "GAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const TEST_IP = "192.168.1.100";

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock Redis client
    mockRedis = {
      set: vi.fn(),
      setex: vi.fn(),
      ttl: vi.fn(),
      del: vi.fn(),
    };

    rateLimiter = new FriendBotRateLimiter(mockRedis, 60);
  });

  describe("checkRateLimit", () => {
    it("allows first request when no cooldown exists", async () => {
      // Mock SET NX EX returning 'OK' (key was set successfully)
      mockRedis.set.mockResolvedValue("OK");

      const result = await rateLimiter.checkRateLimit(TEST_PUBLIC_KEY, TEST_IP);

      expect(result.allowed).toBe(true);
      expect(result.cooldownSeconds).toBe(0);
      expect(result.message).toBe("Request allowed");

      // Verify SET NX EX was called for both key and IP
      expect(mockRedis.set).toHaveBeenCalledWith(
        `friendbot:cooldown:key:${TEST_PUBLIC_KEY}`,
        "1",
        "EX",
        60,
        "NX"
      );
      expect(mockRedis.set).toHaveBeenCalledWith(
        `friendbot:cooldown:ip:${TEST_IP}`,
        "1",
        "EX",
        60,
        "NX"
      );
    });

    it("blocks request when public key cooldown is active", async () => {
      // First call for key returns null (key exists)
      // Second call for IP returns OK (IP is fine)
      mockRedis.set
        .mockResolvedValueOnce(null) // Key cooldown active
        .mockResolvedValueOnce("OK"); // IP cooldown not active

      // Mock TTL for the blocked key
      mockRedis.ttl.mockResolvedValue(45);

      const result = await rateLimiter.checkRateLimit(TEST_PUBLIC_KEY, TEST_IP);

      expect(result.allowed).toBe(false);
      expect(result.cooldownSeconds).toBe(45);
      expect(result.message).toContain("Rate limit exceeded for address");
      expect(result.message).toContain(TEST_PUBLIC_KEY);
      expect(result.message).toContain("45 seconds");
    });

    it("blocks request when IP cooldown is active", async () => {
      // First call for key returns OK (key is fine)
      // Second call for IP returns null (IP cooldown active)
      mockRedis.set
        .mockResolvedValueOnce("OK") // Key cooldown not active
        .mockResolvedValueOnce(null); // IP cooldown active

      // Mock TTL for the blocked IP
      mockRedis.ttl.mockResolvedValue(30);

      const result = await rateLimiter.checkRateLimit(TEST_PUBLIC_KEY, TEST_IP);

      expect(result.allowed).toBe(false);
      expect(result.cooldownSeconds).toBe(30);
      expect(result.message).toContain("Rate limit exceeded for IP");
      expect(result.message).toContain(TEST_IP);
      expect(result.message).toContain("30 seconds");
    });

    it("blocks request when both key and IP have active cooldowns", async () => {
      // Both SET calls return null (both cooldowns active)
      mockRedis.set.mockResolvedValue(null);

      // Return TTL for key (IP TTL won't be checked since key fails first)
      mockRedis.ttl.mockResolvedValue(55);

      const result = await rateLimiter.checkRateLimit(TEST_PUBLIC_KEY, TEST_IP);

      expect(result.allowed).toBe(false);
      expect(result.cooldownSeconds).toBe(55);
      // Should fail on key check first
      expect(result.message).toContain("address");
    });

    it("handles Redis error gracefully by allowing request", async () => {
      mockRedis.set.mockRejectedValue(new Error("Redis connection failed"));

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await rateLimiter.checkRateLimit(TEST_PUBLIC_KEY, TEST_IP);

      expect(result.allowed).toBe(true);
      expect(result.cooldownSeconds).toBe(0);
      expect(consoleSpy).toHaveBeenCalledWith(
        "Redis error in rate limiter:",
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });

    it("handles TTL returning -1 (no expiry) by treating as no cooldown", async () => {
      mockRedis.set.mockResolvedValue(null);
      mockRedis.ttl.mockResolvedValue(-1); // Key exists but no expiry

      const result = await rateLimiter.checkRateLimit(TEST_PUBLIC_KEY, TEST_IP);

      expect(result.allowed).toBe(false);
      expect(result.cooldownSeconds).toBe(0); // Treated as no cooldown
    });

    it("handles TTL returning -2 (key doesn't exist) by treating as no cooldown", async () => {
      mockRedis.set.mockResolvedValue(null);
      mockRedis.ttl.mockResolvedValue(-2); // Key doesn't exist

      const result = await rateLimiter.checkRateLimit(TEST_PUBLIC_KEY, TEST_IP);

      expect(result.allowed).toBe(false);
      expect(result.cooldownSeconds).toBe(0);
    });
  });

  describe("recordRequest", () => {
    it("sets cooldown keys for both public key and IP", async () => {
      mockRedis.setex.mockResolvedValue("OK");

      await rateLimiter.recordRequest(TEST_PUBLIC_KEY, TEST_IP);

      expect(mockRedis.setex).toHaveBeenCalledWith(
        `friendbot:cooldown:key:${TEST_PUBLIC_KEY}`,
        60,
        "1"
      );
      expect(mockRedis.setex).toHaveBeenCalledWith(
        `friendbot:cooldown:ip:${TEST_IP}`,
        60,
        "1"
      );
    });

    it("uses custom cooldown duration", async () => {
      const customLimiter = new FriendBotRateLimiter(mockRedis, 120);
      mockRedis.setex.mockResolvedValue("OK");

      await customLimiter.recordRequest(TEST_PUBLIC_KEY, TEST_IP);

      expect(mockRedis.setex).toHaveBeenCalledWith(
        expect.any(String),
        120,
        "1"
      );
    });
  });

  describe("getRemainingCooldown", () => {
    it("returns remaining seconds when cooldown is active", async () => {
      mockRedis.ttl.mockResolvedValue(42);

      const remaining = await rateLimiter.getRemainingCooldown(TEST_PUBLIC_KEY);

      expect(remaining).toBe(42);
      expect(mockRedis.ttl).toHaveBeenCalledWith(
        `friendbot:cooldown:key:${TEST_PUBLIC_KEY}`
      );
    });

    it("returns 0 when no cooldown is active", async () => {
      mockRedis.ttl.mockResolvedValue(-2); // Key doesn't exist

      const remaining = await rateLimiter.getRemainingCooldown(TEST_PUBLIC_KEY);

      expect(remaining).toBe(0);
    });

    it("returns 0 when TTL is negative", async () => {
      mockRedis.ttl.mockResolvedValue(-1); // No expiry

      const remaining = await rateLimiter.getRemainingCooldown(TEST_PUBLIC_KEY);

      expect(remaining).toBe(0);
    });
  });

  describe("getRemainingCooldownForIp", () => {
    it("returns remaining seconds for IP cooldown", async () => {
      mockRedis.ttl.mockResolvedValue(25);

      const remaining = await rateLimiter.getRemainingCooldownForIp(TEST_IP);

      expect(remaining).toBe(25);
      expect(mockRedis.ttl).toHaveBeenCalledWith(
        `friendbot:cooldown:ip:${TEST_IP}`
      );
    });

    it("returns 0 when no IP cooldown is active", async () => {
      mockRedis.ttl.mockResolvedValue(-2);

      const remaining = await rateLimiter.getRemainingCooldownForIp(TEST_IP);

      expect(remaining).toBe(0);
    });
  });

  describe("resetCooldown", () => {
    it("deletes the cooldown key for public key", async () => {
      mockRedis.del.mockResolvedValue(1);

      await rateLimiter.resetCooldown(TEST_PUBLIC_KEY);

      expect(mockRedis.del).toHaveBeenCalledWith(
        `friendbot:cooldown:key:${TEST_PUBLIC_KEY}`
      );
    });
  });

  describe("resetCooldownForIp", () => {
    it("deletes the cooldown key for IP address", async () => {
      mockRedis.del.mockResolvedValue(1);

      await rateLimiter.resetCooldownForIp(TEST_IP);

      expect(mockRedis.del).toHaveBeenCalledWith(
        `friendbot:cooldown:ip:${TEST_IP}`
      );
    });
  });

  describe("rate limiting scenarios", () => {
    it("enforces cooldown across multiple requests", async () => {
      // First request - allowed
      mockRedis.set.mockResolvedValue("OK");
      const result1 = await rateLimiter.checkRateLimit(TEST_PUBLIC_KEY, TEST_IP);
      expect(result1.allowed).toBe(true);

      // Second request immediately after - blocked
      mockRedis.set.mockResolvedValue(null);
      mockRedis.ttl.mockResolvedValue(58);
      const result2 = await rateLimiter.checkRateLimit(TEST_PUBLIC_KEY, TEST_IP);
      expect(result2.allowed).toBe(false);
      expect(result2.cooldownSeconds).toBe(58);

      // After cooldown expires - allowed again
      mockRedis.set.mockResolvedValue("OK");
      const result3 = await rateLimiter.checkRateLimit(TEST_PUBLIC_KEY, TEST_IP);
      expect(result3.allowed).toBe(true);
    });

    it("allows different public keys from same IP to have independent cooldowns", async () => {
      const KEY1 = "GAAAA...";
      const KEY2 = "GBBBB...";

      // First key allowed
      mockRedis.set.mockResolvedValue("OK");
      const result1 = await rateLimiter.checkRateLimit(KEY1, TEST_IP);
      expect(result1.allowed).toBe(true);

      // Same IP but different key - IP cooldown should block
      mockRedis.set
        .mockResolvedValueOnce("OK") // Key check passes
        .mockResolvedValueOnce(null); // IP check fails
      mockRedis.ttl.mockResolvedValue(45);

      const result2 = await rateLimiter.checkRateLimit(KEY2, TEST_IP);
      expect(result2.allowed).toBe(false);
      expect(result2.message).toContain("IP");
    });
  });
});
