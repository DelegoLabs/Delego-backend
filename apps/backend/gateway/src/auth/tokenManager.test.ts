import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { RefreshToken } from "../models/RefreshToken.js";
import { User } from "../models/User.js";
import {
  issueTokenPair,
  verifyAccessToken,
  rotateRefreshToken,
  revokeTokens,
  introspectToken,
  getJwks,
  getTokenConfig,
} from "./tokenManager.js";
import { isTokenRevokedSync, resetTokenBlacklist } from "./tokenBlacklist.js";
import { resetSigningKeyStore } from "./tokenKeys.js";

function mockDbTokenRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "token-id-1",
    userId: "user-1",
    tokenHash: "hash",
    familyId: "family-1",
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    ...overrides,
  };
}

async function setupTokens() {
  let createdRecord: Record<string, unknown> | null = null;

  vi.spyOn(RefreshToken, "create").mockImplementation(async (data: never) => {
    const d = data as {
      id: string;
      userId: string;
      tokenHash: string;
      familyId: string;
      expiresAt: Date;
    };
    createdRecord = mockDbTokenRecord({
      id: d.id,
      userId: d.userId,
      tokenHash: d.tokenHash,
      familyId: d.familyId,
      expiresAt: d.expiresAt,
    });
    return createdRecord as never;
  });
  vi.spyOn(RefreshToken, "findByPk").mockImplementation(async (id: string) => {
    return createdRecord && createdRecord.id === id ? (createdRecord as never) : null;
  });
  vi.spyOn(RefreshToken, "update").mockResolvedValue([1] as never);
  vi.spyOn(User, "findByPk").mockResolvedValue({
    id: "user-1",
    email: "user@delego.dev",
  } as never);

  const pair = await issueTokenPair("user-1", "user@delego.dev");
  return { pair, record: createdRecord! };
}

describe("JWT token management (Issue #77)", () => {
  beforeEach(() => {
    resetSigningKeyStore();
    resetTokenBlacklist();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("issueTokenPair", () => {
    it("issues an access/refresh pair with short-lived access token", async () => {
      const { pair } = await setupTokens();
      expect(pair.accessToken).toBeTruthy();
      expect(pair.refreshToken).toBeTruthy();
      expect(pair.tokenType).toBe("Bearer");
      expect(pair.expiresIn).toBe(15 * 60); // 15 min
      expect(pair.refreshExpiresIn).toBe(7 * 24 * 60 * 60); // 7 days
      expect(pair.scope).toBe("openid");
    });

    it("verifies the issued access token (asymmetric RS256 by default)", async () => {
      const { pair } = await setupTokens();
      const header = JSON.parse(Buffer.from(pair.accessToken.split(".")[0], "base64url").toString());
      expect(header.alg).toBe("RS256");
      expect(header.kid).toBeTruthy();

      const claims = await verifyAccessToken(pair.accessToken);
      expect(claims.userId).toBe("user-1");
      expect(claims.tokenType).toBe("Bearer");
      expect(claims.jti).toBeTruthy();
    });
  });

  describe("revocation blacklist", () => {
    it("rejects revoked access tokens (fast, in-memory)", async () => {
      const { pair } = await setupTokens();
      const claims = await verifyAccessToken(pair.accessToken);

      await revokeTokens({ token: pair.accessToken, reason: "logout" });

      // In-memory synchronous check — no I/O, well under 10ms.
      expect(isTokenRevokedSync(claims.jti)).toBe(true);
      await expect(verifyAccessToken(pair.accessToken)).rejects.toThrow(/revoked/);
    });
  });

  describe("refresh rotation", () => {
    it("rotates refresh tokens and detects reuse (theft)", async () => {
      const { pair, record } = await setupTokens();
      const rotated = await rotateRefreshToken(pair.refreshToken, {
        deviceId: "device-a",
      });
      expect(rotated.refreshToken).not.toBe(pair.refreshToken);
      expect(rotated.accessToken).toBeTruthy();

      // Second use of the already-rotated token revokes the family.
      const reused = vi.spyOn(RefreshToken, "findByPk").mockResolvedValue({
        ...record,
        revokedAt: new Date(),
      } as never);
      await expect(
        rotateRefreshToken(pair.refreshToken, { deviceId: "device-a" }),
      ).rejects.toThrow(/Token reuse detected/);
      expect(reused).toHaveBeenCalled();
    });
  });

  describe("token binding", () => {
    it("treats a device mismatch on refresh as theft", async () => {
      const { pair } = await setupTokens();
      const bound = await rotateRefreshToken(pair.refreshToken, {
        deviceId: "device-a",
      });
      // Rotating bound the next refresh token to device-a; refreshing from a
      // different device is detected as theft and the token blacklisted.
      await expect(
        rotateRefreshToken(bound.refreshToken, { deviceId: "device-b" }),
      ).rejects.toThrow(/device mismatch/);
      const introspected = await introspectToken(bound.refreshToken);
      expect(introspected.active).toBe(false);
    });

    it("binds device claims into the access token", async () => {
      vi.spyOn(RefreshToken, "create").mockResolvedValue(mockDbTokenRecord() as never);
      const pair = await issueTokenPair("user-1", "user@delego.dev", {
        binding: { deviceId: "device-a" },
      });
      const claims = await verifyAccessToken(pair.accessToken);
      expect(claims.deviceId).toBe("device-a");
    });
  });

  describe("introspection", () => {
    it("returns active=true for a valid token with claims", async () => {
      const { pair } = await setupTokens();
      const result = await introspectToken(pair.accessToken);
      expect(result.active).toBe(true);
      expect(result.userId).toBe("user-1");
      expect(result.jti).toBeTruthy();
      expect(result.exp).toBeGreaterThan(0);
    });

    it("returns active=false for a revoked token", async () => {
      const { pair } = await setupTokens();
      await revokeTokens({ token: pair.accessToken, reason: "security" });
      const result = await introspectToken(pair.accessToken);
      expect(result.active).toBe(false);
    });

    it("returns active=false for an invalid token", async () => {
      const result = await introspectToken("not.a.token");
      expect(result.active).toBe(false);
    });
  });

  describe("JWKS endpoint", () => {
    it("publishes public keys for verification", () => {
      const keys = getJwks();
      expect(keys.length).toBeGreaterThanOrEqual(1);
      const key = keys[0];
      expect(key.kty).toBe("RSA");
      expect(key.use).toBe("sig");
      expect(key.alg).toBe("RS256");
      expect(key.kid).toBeTruthy();
      expect(key.n).toBeTruthy();
      expect(key.e).toBeTruthy();
    });

    it("keeps old keys verifiable after rotation (no downtime)", async () => {
      const { pair } = await setupTokens();
      const store = (await import("./tokenKeys.js")).getSigningKeyStore();

      // Rotate: the old token must still verify afterwards.
      store.rotate();
      const claims = await verifyAccessToken(pair.accessToken);
      expect(claims.userId).toBe("user-1");

      // New tokens are signed with the new key.
      const { pair: second } = await setupTokens();
      const header = JSON.parse(
        Buffer.from(second.accessToken.split(".")[0], "base64url").toString(),
      );
      expect(header.kid).not.toBe(
        JSON.parse(Buffer.from(pair.accessToken.split(".")[0], "base64url").toString()).kid,
      );
    });
  });

  describe("configuration", () => {
    it("exposes the effective token configuration", () => {
      const cfg = getTokenConfig();
      expect(cfg.accessTokenTtlSeconds).toBe(15 * 60);
      expect(cfg.refreshTokenTtlSeconds).toBe(7 * 24 * 60 * 60);
      expect(cfg.rotationEnabled).toBe(true);
      expect(cfg.signingAlgorithm).toBe("RS256");
      expect(cfg.issuer).toBe("delego-gateway");
      expect(cfg.audience).toBe("delego-clients");
    });
  });
});
