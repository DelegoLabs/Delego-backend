/**
 * JWT token management with rotation, revocation, binding and theft
 * detection (Issue #77).
 *
 * Provides:
 *  - access/refresh token pairs (access tokens short-lived, 15m default)
 *  - refresh-token rotation with reuse detection (family revocation)
 *  - fast revocation via a Redis + in-memory blacklist
 *  - RFC 7662-style introspection
 *  - asymmetric signing (RS256/ES256) with HS256 fallback
 *  - token binding to a device/fingerprint to prevent replay
 *  - theft detection on device mismatch or refresh-token reuse
 */

import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt, { type VerifyOptions } from "jsonwebtoken";
import { Op } from "sequelize";
import { RefreshToken } from "../models/RefreshToken.js";
import { User } from "../models/User.js";
import { getSigningKeyStore } from "./tokenKeys.js";
import { isTokenRevoked, revokeToken } from "./tokenBlacklist.js";
import type {
  IntrospectionResult,
  JWKSKey,
  RevocationReason,
  RevokedToken,
  SigningAlgorithm,
  TokenBinding,
  TokenClaims,
  TokenConfig,
  TokenPair,
} from "./tokenTypes.js";

const DEFAULT_ACCESS_TTL_SECONDS = 15 * 60; // 15 minutes
const DEFAULT_REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 5;
const MAX_CLOCK_TOLERANCE_SECONDS = 300;

export interface JwtValidationConfig {
  issuer: string;
  audience: string;
  clockToleranceSeconds: number;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

export function getJwtValidationConfig(): JwtValidationConfig {
  return {
    issuer: process.env.JWT_ISSUER ?? "delego-gateway",
    audience: process.env.JWT_AUDIENCE ?? "delego-clients",
    clockToleranceSeconds: parseClockTolerance(process.env.JWT_CLOCK_TOLERANCE_SECONDS),
  };
}

export function parseClockTolerance(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_CLOCK_TOLERANCE_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CLOCK_TOLERANCE_SECONDS;
  return Math.min(Math.floor(parsed), MAX_CLOCK_TOLERANCE_SECONDS);
}

/** Active token management configuration (environment-driven). */
export function getTokenConfig(): TokenConfig {
  return {
    accessTokenTtlSeconds: parsePositiveInt(
      process.env.JWT_ACCESS_TOKEN_TTL_SECONDS,
      DEFAULT_ACCESS_TTL_SECONDS,
    ),
    refreshTokenTtlSeconds: parsePositiveInt(
      process.env.JWT_REFRESH_TOKEN_TTL_SECONDS,
      DEFAULT_REFRESH_TTL_SECONDS,
    ),
    rotationEnabled: (process.env.JWT_ROTATION_ENABLED ?? "true") !== "false",
    signingAlgorithm: (process.env.JWT_SIGNING_ALGORITHM?.toUpperCase() ??
      "RS256") as SigningAlgorithm,
    issuer: process.env.JWT_ISSUER ?? "delego-gateway",
    audience: process.env.JWT_AUDIENCE ?? "delego-clients",
  };
}

export interface IssueTokenOptions {
  roles?: string[];
  binding?: TokenBinding;
  scope?: string;
  familyId?: string;
}

// ---------------------------------------------------------------------------
// Signing / verification primitives
// ---------------------------------------------------------------------------

interface AccessTokenInput {
  userId: string;
  email?: string;
  roles?: string[];
  binding?: TokenBinding;
  scope: string;
}

function signAccessToken(input: AccessTokenInput): string {
  const cfg = getTokenConfig();
  const store = getSigningKeyStore();
  const now = Math.floor(Date.now() / 1000);
  return store.sign(
    {
      sub: input.userId,
      userId: input.userId,
      email: input.email,
      roles: input.roles ?? ["user"],
      jti: randomUUID(),
      scope: input.scope,
      tokenType: "Bearer",
      deviceId: input.binding?.deviceId,
      fingerprint: input.binding?.fingerprint,
      iss: cfg.issuer,
      aud: cfg.audience,
      iat: now,
      nbf: now,
    },
    { expiresIn: cfg.accessTokenTtlSeconds },
  );
}

async function createRefreshToken(
  userId: string,
  binding: TokenBinding | undefined,
  scope: string,
  familyId?: string,
): Promise<{ refreshToken: string; familyId: string; tokenId: string }> {
  const cfg = getTokenConfig();
  const tokenId = randomUUID();
  const family = familyId ?? randomUUID();
  const expiresAt = new Date(Date.now() + cfg.refreshTokenTtlSeconds * 1000);
  const secret = randomUUID();
  const tokenHash = await bcrypt.hash(secret, 10);

  await RefreshToken.create({
    id: tokenId,
    userId,
    tokenHash,
    familyId: family,
    expiresAt,
  });

  const store = getSigningKeyStore();
  const now = Math.floor(Date.now() / 1000);
  const refreshToken = store.sign(
    {
      sub: userId,
      userId,
      jti: tokenId,
      tokenId,
      familyId: family,
      secret,
      scope,
      tokenType: "refresh",
      deviceId: binding?.deviceId,
      fingerprint: binding?.fingerprint,
      iss: cfg.issuer,
      aud: cfg.audience,
      iat: now,
      nbf: now,
    },
    { expiresIn: cfg.refreshTokenTtlSeconds },
  );

  return { refreshToken, familyId: family, tokenId };
}

/** Verifies a token signature against the active/retired keys. */
export function verifyWithStore(token: string, options: VerifyOptions = {}): jwt.JwtPayload {
  const decoded = getSigningKeyStore().verify(token, options);
  if (typeof decoded === "string") {
    throw new Error("Invalid token structure");
  }
  return decoded as jwt.JwtPayload;
}

function normalizeClaims(decoded: jwt.JwtPayload): TokenClaims {
  const userId = typeof decoded.userId === "string" ? decoded.userId : String(decoded.sub ?? "");
  if (!userId) throw new Error("Invalid token structure");

  return {
    sub: String(decoded.sub ?? userId),
    userId,
    email: typeof decoded.email === "string" ? decoded.email : undefined,
    roles: Array.isArray(decoded.roles) ? (decoded.roles as string[]) : undefined,
    jti: typeof decoded.jti === "string" ? decoded.jti : randomUUID(),
    kid: typeof decoded.kid === "string" ? decoded.kid : undefined,
    deviceId: typeof decoded.deviceId === "string" ? decoded.deviceId : undefined,
    fingerprint: typeof decoded.fingerprint === "string" ? decoded.fingerprint : undefined,
    scope: typeof decoded.scope === "string" ? decoded.scope : "openid",
    tokenType: decoded.tokenType === "refresh" ? "refresh" : "Bearer",
    familyId: typeof decoded.familyId === "string" ? decoded.familyId : undefined,
    secret: typeof decoded.secret === "string" ? decoded.secret : undefined,
    iat: typeof decoded.iat === "number" ? decoded.iat : Math.floor(Date.now() / 1000),
    exp: typeof decoded.exp === "number" ? decoded.exp : Math.floor(Date.now() / 1000),
    nbf: typeof decoded.nbf === "number" ? decoded.nbf : undefined,
    iss: typeof decoded.iss === "string" ? decoded.iss : undefined,
    aud: typeof decoded.aud === "string" ? decoded.aud : undefined,
  };
}

function verifyRefreshToken(token: string): TokenClaims {
  const cfg = getTokenConfig();
  const decoded = verifyWithStore(token, {
    issuer: cfg.issuer,
    audience: cfg.audience,
    clockTolerance: parseClockTolerance(process.env.JWT_CLOCK_TOLERANCE_SECONDS),
  });
  const claims = normalizeClaims(decoded);
  if (claims.tokenType !== "refresh" || !claims.familyId || !claims.secret) {
    throw new Error("Invalid refresh token structure");
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Issues a standalone access token (used by generateToken / middleware). */
export function issueAccessToken(
  userId: string,
  email: string,
  options: { roles?: string[]; binding?: TokenBinding; scope?: string } = {},
): string {
  return signAccessToken({
    userId,
    email,
    roles: options.roles ?? ["user"],
    binding: options.binding,
    scope: options.scope ?? "openid",
  });
}

/** Issues a new access/refresh token pair bound to an optional device. */
export async function issueTokenPair(
  userId: string,
  email: string,
  options: IssueTokenOptions = {},
): Promise<TokenPair> {
  const cfg = getTokenConfig();
  const { roles = ["user"], binding, scope = "openid", familyId } = options;

  const accessToken = signAccessToken({ userId, email, roles, binding, scope });
  const { refreshToken } = await createRefreshToken(userId, binding, scope, familyId);

  return {
    accessToken,
    refreshToken,
    expiresIn: cfg.accessTokenTtlSeconds,
    refreshExpiresIn: cfg.refreshTokenTtlSeconds,
    tokenType: "Bearer",
    scope,
  };
}

/**
 * Verifies an access token (signature + optional blacklist check).
 * Throws when the token is invalid, expired, or revoked.
 */
export async function verifyAccessToken(
  token: string,
  opts: { checkRevoked?: boolean } = {},
): Promise<TokenClaims> {
  const cfg = getTokenConfig();
  const claims = normalizeClaims(
    verifyWithStore(token, {
      issuer: cfg.issuer,
      audience: cfg.audience,
      clockTolerance: parseClockTolerance(process.env.JWT_CLOCK_TOLERANCE_SECONDS),
    }),
  );
  if (claims.tokenType !== "Bearer") {
    throw new Error("Invalid token type");
  }
  if (opts.checkRevoked !== false && (await isTokenRevoked(claims.jti))) {
    throw new Error("Token has been revoked");
  }
  return claims;
}

async function revokeRefreshFamily(familyId: string): Promise<void> {
  await RefreshToken.update({ revokedAt: new Date() }, { where: { familyId } });
}

/**
 * Rotates a refresh token into a fresh pair. When `rotationEnabled` is off,
 * the same refresh token is returned with a fresh access token. Reuse of an
 * already-rotated token revokes the entire family (theft detection), as does
 * use from a different device than the token was bound to.
 */
export async function rotateRefreshToken(
  rawRefreshToken: string,
  binding?: TokenBinding,
): Promise<TokenPair> {
  const cfg = getTokenConfig();
  const decoded = verifyRefreshToken(rawRefreshToken);

  if (await isTokenRevoked(decoded.jti)) {
    throw new Error("Token has been revoked");
  }

  const tokenRecord = await RefreshToken.findByPk(decoded.jti);
  if (!tokenRecord) {
    throw new Error("Invalid refresh token");
  }

  const isSecretValid = await bcrypt.compare(decoded.secret ?? "", tokenRecord.tokenHash);
  if (!isSecretValid) {
    throw new Error("Invalid refresh token");
  }

  if (tokenRecord.expiresAt < new Date()) {
    throw new Error("Refresh token expired");
  }

  // Token binding — replay from a different device is treated as theft.
  if (binding?.deviceId && decoded.deviceId && binding.deviceId !== decoded.deviceId) {
    await revokeRefreshFamily(tokenRecord.familyId);
    await revokeToken({
      jti: decoded.jti,
      userId: decoded.userId,
      revokedAt: new Date().toISOString(),
      reason: "security",
      expiresAt: tokenRecord.expiresAt.toISOString(),
    });
    throw new Error("Token theft detected: device mismatch");
  }

  const user = await User.findByPk(tokenRecord.userId);

  if (!cfg.rotationEnabled) {
    return {
      accessToken: signAccessToken({
        userId: tokenRecord.userId,
        email: user?.email ?? "",
        roles: ["user"],
        binding,
        scope: decoded.scope ?? "openid",
      }),
      refreshToken: rawRefreshToken,
      expiresIn: cfg.accessTokenTtlSeconds,
      refreshExpiresIn: cfg.refreshTokenTtlSeconds,
      tokenType: "Bearer",
      scope: decoded.scope ?? "openid",
    };
  }

  // Reuse detection — a previously-rotated token being used again means theft.
  if (tokenRecord.revokedAt) {
    await revokeRefreshFamily(tokenRecord.familyId);
    throw new Error("Token reuse detected");
  }

  const [affectedCount] = await RefreshToken.update(
    { revokedAt: new Date() },
    { where: { id: decoded.jti, revokedAt: { [Op.is]: null } } },
  );

  if (affectedCount === 0) {
    await revokeRefreshFamily(tokenRecord.familyId);
    throw new Error("Token reuse detected");
  }

  const { refreshToken } = await createRefreshToken(
    tokenRecord.userId,
    binding,
    decoded.scope ?? "openid",
    tokenRecord.familyId,
  );

  return {
    accessToken: signAccessToken({
      userId: tokenRecord.userId,
      email: user?.email ?? "",
      roles: ["user"],
      binding,
      scope: decoded.scope ?? "openid",
    }),
    refreshToken,
    expiresIn: cfg.accessTokenTtlSeconds,
    refreshExpiresIn: cfg.refreshTokenTtlSeconds,
    tokenType: "Bearer",
    scope: decoded.scope ?? "openid",
  };
}

/**
 * Revokes an access token and/or refresh token. The refresh token's whole
 * family is revoked, and all presented token jtis are blacklisted.
 */
export async function revokeTokens(params: {
  token?: string;
  refreshToken?: string;
  userId?: string;
  reason?: RevocationReason;
}): Promise<{ revoked: number; revokedFamily: boolean }> {
  const reason: RevocationReason = params.reason ?? "logout";
  const entries: RevokedToken[] = [];

  if (params.token) {
    try {
      const cfg = getTokenConfig();
      const claims = normalizeClaims(
        verifyWithStore(params.token, {
          issuer: cfg.issuer,
          audience: cfg.audience,
          clockTolerance: parseClockTolerance(process.env.JWT_CLOCK_TOLERANCE_SECONDS),
        }),
      );
      if (claims.tokenType === "Bearer") {
        entries.push({
          jti: claims.jti,
          userId: params.userId ?? claims.userId,
          revokedAt: new Date().toISOString(),
          reason,
          expiresAt: new Date(claims.exp * 1000).toISOString(),
        });
      }
    } catch {
      // Ignore invalid tokens during revocation.
    }
  }

  let revokedFamily = false;
  if (params.refreshToken) {
    try {
      const claims = verifyRefreshToken(params.refreshToken);
      entries.push({
        jti: claims.jti,
        userId: params.userId ?? claims.userId,
        revokedAt: new Date().toISOString(),
        reason,
        expiresAt: new Date(claims.exp * 1000).toISOString(),
      });
      await revokeRefreshFamily(claims.familyId!);
      revokedFamily = true;
    } catch {
      // Ignore invalid refresh tokens during revocation.
    }
  }

  for (const entry of entries) {
    await revokeToken(entry);
  }

  return { revoked: entries.length, revokedFamily };
}

/** RFC 7662-style token introspection. */
export async function introspectToken(token: string): Promise<IntrospectionResult> {
  const cfg = getTokenConfig();
  try {
    const claims = normalizeClaims(
      verifyWithStore(token, {
        issuer: cfg.issuer,
        audience: cfg.audience,
        clockTolerance: parseClockTolerance(process.env.JWT_CLOCK_TOLERANCE_SECONDS),
      }),
    );

    if (await isTokenRevoked(claims.jti)) {
      return {
        active: false,
        jti: claims.jti,
        userId: claims.userId,
        exp: claims.exp,
      };
    }

    return {
      active: true,
      tokenType: claims.tokenType,
      jti: claims.jti,
      userId: claims.userId,
      email: claims.email,
      scope: claims.scope,
      iat: claims.iat,
      exp: claims.exp,
      nbf: claims.nbf,
      iss: claims.iss,
      aud: claims.aud,
      deviceId: claims.deviceId,
    };
  } catch {
    return { active: false };
  }
}

/** JWKS payload for the `.well-known/jwks.json` endpoint. */
export function getJwks(): JWKSKey[] {
  return getSigningKeyStore().getJwks();
}

export type { TokenClaims };
