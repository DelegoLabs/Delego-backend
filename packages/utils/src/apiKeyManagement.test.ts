import { describe, it, expect } from "vitest";
import {
  generateApiKey,
  verifyApiKey,
  rotateApiKey,
  computeRotationRevocationAt,
  isExpired,
  isIpAllowed,
  hasScope,
  authorizeApiKeyRequest,
  checkForCompromise,
  type ApiKey,
  type ApiKeyConfig,
} from "./apiKeyManagement.js";

function buildConfig(overrides: Partial<ApiKeyConfig> = {}): ApiKeyConfig {
  return {
    prefix: "sk_live_",
    defaultScopes: ["read:orders"],
    maxKeysPerUser: 5,
    defaultExpiryDays: 90,
    rotationOverlapDays: 7,
    ...overrides,
  };
}

describe("generateApiKey", () => {
  it("generates a key with the configured prefix", async () => {
    const { rawKey } = await generateApiKey(buildConfig(), { name: "CI key", userId: "u1" });
    expect(rawKey.startsWith("sk_live_")).toBe(true);
  });

  it("stores only a bcrypt hash, never the raw key", async () => {
    const { rawKey, record } = await generateApiKey(buildConfig(), { name: "CI key", userId: "u1" });
    expect(record.hashedKey).not.toBe(rawKey);
    expect(record.hashedKey.startsWith("$2")).toBe(true); // bcrypt hash format
  });

  it("generates a different raw key each time (sufficient entropy, no collisions in practice)", async () => {
    const config = buildConfig();
    const a = await generateApiKey(config, { name: "a", userId: "u1" });
    const b = await generateApiKey(config, { name: "b", userId: "u1" });
    expect(a.rawKey).not.toBe(b.rawKey);
  });

  it("defaults to the config's defaultScopes when none are given", async () => {
    const { record } = await generateApiKey(buildConfig({ defaultScopes: ["read:x"] }), {
      name: "k",
      userId: "u1",
    });
    expect(record.scopes).toEqual(["read:x"]);
  });

  it("uses explicitly provided scopes over the default", async () => {
    const { record } = await generateApiKey(buildConfig(), {
      name: "k",
      userId: "u1",
      scopes: ["write:orders"],
    });
    expect(record.scopes).toEqual(["write:orders"]);
  });

  it("sets expiresAt based on defaultExpiryDays", async () => {
    const now = () => new Date("2026-01-01T00:00:00.000Z");
    const { record } = await generateApiKey(buildConfig({ defaultExpiryDays: 30 }), { name: "k", userId: "u1" }, now);
    expect(record.expiresAt).toBe("2026-01-31T00:00:00.000Z");
  });

  it("starts a new key as active with zero usage", async () => {
    const { record } = await generateApiKey(buildConfig(), { name: "k", userId: "u1" });
    expect(record.status).toBe("active");
    expect(record.usageCount).toBe(0);
  });
});

describe("verifyApiKey", () => {
  it("verifies a correct raw key against its hash", async () => {
    const { rawKey, record } = await generateApiKey(buildConfig(), { name: "k", userId: "u1" });
    expect(await verifyApiKey(rawKey, record.hashedKey)).toBe(true);
  });

  it("rejects an incorrect raw key", async () => {
    const { record } = await generateApiKey(buildConfig(), { name: "k", userId: "u1" });
    expect(await verifyApiKey("sk_live_wrongkey", record.hashedKey)).toBe(false);
  });
});

describe("rotateApiKey", () => {
  it("generates a new key inheriting the original's scopes and allowlist", async () => {
    const { record: original } = await generateApiKey(buildConfig(), {
      name: "k",
      userId: "u1",
      scopes: ["read:x", "write:x"],
      ipAllowlist: ["1.2.3.4"],
    });
    const { record: rotated } = await rotateApiKey(buildConfig(), original);
    expect(rotated.scopes).toEqual(["read:x", "write:x"]);
    expect(rotated.ipAllowlist).toEqual(["1.2.3.4"]);
  });

  it("links the new key back to the original via rotatedFrom", async () => {
    const { record: original } = await generateApiKey(buildConfig(), { name: "k", userId: "u1" });
    const { record: rotated } = await rotateApiKey(buildConfig(), original);
    expect(rotated.rotatedFrom).toBe(original.id);
  });

  it("produces a genuinely different key material from the original", async () => {
    const { rawKey: originalRaw, record: original } = await generateApiKey(buildConfig(), {
      name: "k",
      userId: "u1",
    });
    const { rawKey: rotatedRaw } = await rotateApiKey(buildConfig(), original);
    expect(rotatedRaw).not.toBe(originalRaw);
  });

  it("does not revoke the original key (overlap period is the caller's responsibility)", async () => {
    const { record: original } = await generateApiKey(buildConfig(), { name: "k", userId: "u1" });
    await rotateApiKey(buildConfig(), original);
    expect(original.status).toBe("active");
  });
});

describe("computeRotationRevocationAt", () => {
  it("adds rotationOverlapDays to the rotation timestamp", () => {
    const rotatedAt = new Date("2026-01-01T00:00:00.000Z");
    const revokeAt = computeRotationRevocationAt(buildConfig({ rotationOverlapDays: 7 }), rotatedAt);
    expect(revokeAt.toISOString()).toBe("2026-01-08T00:00:00.000Z");
  });
});

function buildKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "key-1",
    prefix: "sk_live_",
    name: "test key",
    hashedKey: "hashed",
    scopes: ["read:orders"],
    userId: "u1",
    ipAllowlist: [],
    usageCount: 0,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("isExpired", () => {
  it("returns false when there is no expiresAt", () => {
    expect(isExpired(buildKey({ expiresAt: undefined }))).toBe(false);
  });

  it("returns true once past expiresAt", () => {
    const key = buildKey({ expiresAt: "2026-01-01T00:00:00.000Z" });
    expect(isExpired(key, new Date("2026-01-02T00:00:00.000Z"))).toBe(true);
  });

  it("returns false before expiresAt", () => {
    const key = buildKey({ expiresAt: "2026-06-01T00:00:00.000Z" });
    expect(isExpired(key, new Date("2026-01-02T00:00:00.000Z"))).toBe(false);
  });
});

describe("isIpAllowed", () => {
  it("allows any IP when the allowlist is empty", () => {
    expect(isIpAllowed(buildKey({ ipAllowlist: [] }), "9.9.9.9")).toBe(true);
  });

  it("allows an IP present in the allowlist", () => {
    expect(isIpAllowed(buildKey({ ipAllowlist: ["1.2.3.4"] }), "1.2.3.4")).toBe(true);
  });

  it("rejects an IP not present in a non-empty allowlist", () => {
    expect(isIpAllowed(buildKey({ ipAllowlist: ["1.2.3.4"] }), "9.9.9.9")).toBe(false);
  });
});

describe("hasScope", () => {
  it("returns true when the scope is present", () => {
    expect(hasScope(buildKey({ scopes: ["read:orders"] }), "read:orders")).toBe(true);
  });

  it("returns false when the scope is absent", () => {
    expect(hasScope(buildKey({ scopes: ["read:orders"] }), "write:orders")).toBe(false);
  });

  it("treats '*' as a wildcard granting any scope", () => {
    expect(hasScope(buildKey({ scopes: ["*"] }), "write:anything")).toBe(true);
  });
});

describe("authorizeApiKeyRequest", () => {
  it("authorizes a valid, in-scope, allowed-IP request", () => {
    const key = buildKey({ status: "active", ipAllowlist: [], scopes: ["read:orders"] });
    const result = authorizeApiKeyRequest(key, { ipAddress: "1.2.3.4", requiredScope: "read:orders" });
    expect(result.authorized).toBe(true);
  });

  it("denies a revoked key", () => {
    const key = buildKey({ status: "revoked" });
    expect(authorizeApiKeyRequest(key, { ipAddress: "1.2.3.4" }).reason).toBe("revoked");
  });

  it("denies an expired key", () => {
    const key = buildKey({ status: "expired" });
    expect(authorizeApiKeyRequest(key, { ipAddress: "1.2.3.4" }).reason).toBe("expired");
  });

  it("denies a request from an IP not on the allowlist", () => {
    const key = buildKey({ ipAllowlist: ["1.2.3.4"] });
    expect(authorizeApiKeyRequest(key, { ipAddress: "9.9.9.9" }).reason).toBe("ip_not_allowed");
  });

  it("denies a request missing the required scope", () => {
    const key = buildKey({ scopes: ["read:orders"] });
    expect(authorizeApiKeyRequest(key, { ipAddress: "1.2.3.4", requiredScope: "write:orders" }).reason).toBe(
      "missing_scope",
    );
  });

  it("checks revocation before expiry, and expiry before IP/scope (priority order)", () => {
    const key = buildKey({ status: "revoked", expiresAt: "2020-01-01T00:00:00.000Z", ipAllowlist: ["1.2.3.4"] });
    expect(authorizeApiKeyRequest(key, { ipAddress: "9.9.9.9" }).reason).toBe("revoked");
  });
});

describe("checkForCompromise", () => {
  it("reports not suspicious for normal usage", () => {
    const result = checkForCompromise({
      recentUsage: [{ keyId: "k1", endpoint: "/x", method: "GET", statusCode: 200, latencyMs: 10, timestamp: "t", ipAddress: "1.1.1.1" }],
      baselineRequestsPerHour: 100,
    });
    expect(result.suspicious).toBe(false);
  });

  it("flags a request-volume spike far above baseline", () => {
    const usage = Array.from({ length: 600 }, () => ({
      keyId: "k1",
      endpoint: "/x",
      method: "GET",
      statusCode: 200,
      latencyMs: 10,
      timestamp: "t",
      ipAddress: "1.1.1.1",
    }));
    const result = checkForCompromise({ recentUsage: usage, baselineRequestsPerHour: 100 });
    expect(result.suspicious).toBe(true);
    expect(result.reasons.some((r) => r.includes("baseline"))).toBe(true);
  });

  it("flags requests from an unusually high number of distinct IPs", () => {
    const usage = Array.from({ length: 10 }, (_, i) => ({
      keyId: "k1",
      endpoint: "/x",
      method: "GET",
      statusCode: 200,
      latencyMs: 10,
      timestamp: "t",
      ipAddress: `1.1.1.${i}`,
    }));
    const result = checkForCompromise({ recentUsage: usage, baselineRequestsPerHour: 1000, maxDistinctIps: 5 });
    expect(result.suspicious).toBe(true);
    expect(result.reasons.some((r) => r.includes("distinct IPs"))).toBe(true);
  });
});
