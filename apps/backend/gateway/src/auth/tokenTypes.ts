/**
 * JWT token management data types (Issue #77)
 *
 * Mirrors the shapes requested in the issue:
 *   TokenPair, TokenConfig, RevokedToken, JWKSKey
 */

export type SigningAlgorithm = "RS256" | "ES256" | "HS256";

export type TokenType = "Bearer";

export type RevocationReason = "logout" | "password_change" | "security" | "admin";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds
  refreshExpiresIn: number; // seconds
  tokenType: TokenType;
  scope: string;
}

export interface TokenConfig {
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  rotationEnabled: boolean;
  signingAlgorithm: SigningAlgorithm;
  issuer: string;
  audience: string;
}

export interface RevokedToken {
  jti: string; // JWT ID
  userId: string;
  revokedAt: string;
  reason: RevocationReason;
  expiresAt: string; // original expiry
}

export interface JWKSKey {
  kty: string;
  kid: string;
  use: "sig";
  alg: string;
  n?: string; // modulus for RSA
  e?: string; // exponent for RSA
  crv?: string; // curve for EC
  x?: string;
  y?: string;
}

/**
 * Token binding — binds a token pair to a device/fingerprint so a stolen
 * token cannot be replayed from a different client.
 */
export interface TokenBinding {
  /** Stable per-device identifier supplied by the client. */
  deviceId: string;
  /** HMAC-style fingerprint derived from client headers (optional). */
  fingerprint?: string;
}

export interface TokenClaims {
  /** Subject — the user id. */
  sub: string;
  userId: string;
  email?: string;
  roles?: string[];
  /** JWT ID used for blacklisting. */
  jti: string;
  /** Key id of the signing key. */
  kid?: string;
  /** Device binding claims. */
  deviceId?: string;
  fingerprint?: string;
  scope?: string;
  tokenType?: TokenType | "refresh";
  familyId?: string;
  secret?: string;
  iat: number;
  exp: number;
  nbf?: number;
  iss?: string;
  aud?: string;
}

export type IntrospectionResult = {
  active: boolean;
  tokenType?: TokenType | "refresh";
  jti?: string;
  userId?: string;
  email?: string;
  scope?: string;
  iat?: number;
  exp?: number;
  nbf?: number;
  iss?: string;
  aud?: string;
  deviceId?: string;
};
