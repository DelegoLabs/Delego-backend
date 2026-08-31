import { describe, expect, it } from "vitest";
import { DEFAULT_TIER_CONFIGS, normalizeTier, resolveRateLimitConfig } from "./tierConfig.js";

describe("normalizeTier", () => {
  it("passes through known tiers", () => {
    expect(normalizeTier("pro")).toBe("pro");
    expect(normalizeTier("enterprise")).toBe("enterprise");
    expect(normalizeTier("internal")).toBe("internal");
    expect(normalizeTier("free")).toBe("free");
  });

  it("falls back to 'free' for unknown or missing tiers", () => {
    expect(normalizeTier("nonsense")).toBe("free");
    expect(normalizeTier(undefined)).toBe("free");
    expect(normalizeTier(null)).toBe("free");
    expect(normalizeTier("")).toBe("free");
  });
});

describe("resolveRateLimitConfig", () => {
  it("returns the tier's default config with no endpoint", () => {
    const config = resolveRateLimitConfig("pro");
    expect(config).toEqual(DEFAULT_TIER_CONFIGS.pro);
  });

  it("escalates tiers to strictly higher capacity", () => {
    const free = resolveRateLimitConfig("free");
    const pro = resolveRateLimitConfig("pro");
    const enterprise = resolveRateLimitConfig("enterprise");
    const internal = resolveRateLimitConfig("internal");

    expect(pro.requestsPerWindow).toBeGreaterThan(free.requestsPerWindow);
    expect(enterprise.requestsPerWindow).toBeGreaterThan(pro.requestsPerWindow);
    expect(internal.requestsPerWindow).toBeGreaterThan(enterprise.requestsPerWindow);
  });

  it("applies a stricter endpoint override on top of the tier", () => {
    const config = resolveRateLimitConfig("enterprise", "/api/v1/auth/login", "POST");
    expect(config.requestsPerWindow).toBe(5);
    expect(config.tier).toBe("enterprise");
  });

  it("never lets an override raise a lower tier's limit above its own default", () => {
    // free's default requestsPerWindow (60) is already below a hypothetical
    // override of 5 for login, so the override (the stricter of the two) wins.
    const config = resolveRateLimitConfig("free", "/api/v1/auth/login", "POST");
    expect(config.requestsPerWindow).toBe(5);
  });

  it("ignores overrides for endpoints with no configured rule", () => {
    const config = resolveRateLimitConfig("pro", "/api/v1/orders", "GET");
    expect(config).toEqual(DEFAULT_TIER_CONFIGS.pro);
  });
});
