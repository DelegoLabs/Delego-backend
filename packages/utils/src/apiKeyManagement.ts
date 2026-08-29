/**
 * API key generation, hashing, and rotation logic (Issue #78).
 *
 * This implements the generation/hashing/rotation/scope/IP-allowlist
 * logic as pure functions plus a minimal in-memory reference store — it
 * does not hardcode a persistence layer (Sequelize model, Redis, etc.),
 * since that's an implementation detail each service integrating this
 * should choose. Hashing uses bcryptjs, matching this repo's existing
 * convention (see apps/backend/gateway/src/auth/tokenManager.ts).
 */

import bcrypt from "bcryptjs";
import { randomBytes, randomUUID } from "node:crypto";

export type ApiKeyStatus = "active" | "revoked" | "expired";

export interface ApiKey {
  id: string;
  prefix: string;
  name: string;
  hashedKey: string;
  scopes: string[];
  userId: string;
  organizationId?: string;
  ipAllowlist: string[];
  expiresAt?: string;
  lastUsedAt?: string;
  usageCount: number;
  status: ApiKeyStatus;
  createdAt: string;
  rotatedFrom?: string;
}

export interface ApiKeyConfig {
  prefix: string;
  defaultScopes: string[];
  maxKeysPerUser: number;
  defaultExpiryDays: number;
  rotationOverlapDays: number;
}

export interface ApiKeyUsage {
  keyId: string;
  endpoint: string;
  method: string;
  statusCode: number;
  latencyMs: number;
  timestamp: string;
  ipAddress: string;
}

const BCRYPT_ROUNDS = 10;
const RAW_KEY_BYTES = 32;

export interface GeneratedApiKey {
  /** The full raw key, shown to the caller exactly once. Never stored. */
  rawKey: string;
  record: ApiKey;
}

/**
 * Generate a new API key: a cryptographically random secret prefixed for
 * identification (e.g. "sk_live_"), hashed for storage.
 */
export async function generateApiKey(
  config: ApiKeyConfig,
  input: { name: string; userId: string; organizationId?: string; scopes?: string[]; ipAllowlist?: string[] },
  now: () => Date = () => new Date(),
): Promise<GeneratedApiKey> {
  const secret = randomBytes(RAW_KEY_BYTES).toString("hex");
  const rawKey = `${config.prefix}${secret}`;
  const hashedKey = await bcrypt.hash(rawKey, BCRYPT_ROUNDS);

  const createdAt = now();
  const expiresAt = new Date(createdAt.getTime() + config.defaultExpiryDays * 86400_000);

  const record: ApiKey = {
    id: randomUUID(),
    prefix: config.prefix,
    name: input.name,
    hashedKey,
    scopes: input.scopes ?? config.defaultScopes,
    userId: input.userId,
    organizationId: input.organizationId,
    ipAllowlist: input.ipAllowlist ?? [],
    expiresAt: expiresAt.toISOString(),
    usageCount: 0,
    status: "active",
    createdAt: createdAt.toISOString(),
  };

  return { rawKey, record };
}

/** Verify a raw key against its stored hash. */
export async function verifyApiKey(rawKey: string, hashedKey: string): Promise<boolean> {
  return bcrypt.compare(rawKey, hashedKey);
}

/**
 * Rotate an API key: generate a replacement key that inherits the
 * original's scopes/allowlist, and mark the lineage via `rotatedFrom`.
 * The original key is intentionally left `active` by this function — the
 * caller decides when to revoke it, since a rotation with an overlap
 * period (per ApiKeyConfig.rotationOverlapDays) requires both keys to
 * remain valid until the overlap window closes.
 */
export async function rotateApiKey(
  config: ApiKeyConfig,
  original: ApiKey,
  now: () => Date = () => new Date(),
): Promise<GeneratedApiKey> {
  const { rawKey, record } = await generateApiKey(
    config,
    { name: original.name, userId: original.userId, organizationId: original.organizationId, scopes: original.scopes, ipAllowlist: original.ipAllowlist },
    now,
  );
  return { rawKey, record: { ...record, rotatedFrom: original.id } };
}

/** Compute the timestamp at which an original key should be revoked after
 * a rotation, given the configured overlap period. */
export function computeRotationRevocationAt(config: ApiKeyConfig, rotatedAt: Date): Date {
  return new Date(rotatedAt.getTime() + config.rotationOverlapDays * 86400_000);
}

export function isExpired(key: ApiKey, now: Date = new Date()): boolean {
  if (!key.expiresAt) return false;
  return new Date(key.expiresAt).getTime() <= now.getTime();
}

export function isIpAllowed(key: ApiKey, ipAddress: string): boolean {
  if (key.ipAllowlist.length === 0) return true; // no allowlist configured = unrestricted
  return key.ipAllowlist.includes(ipAddress);
}

export function hasScope(key: ApiKey, requiredScope: string): boolean {
  return key.scopes.includes(requiredScope) || key.scopes.includes("*");
}

/**
 * Full authorization check for an incoming request against a key: status,
 * expiry, IP allowlist, and (when a scope is required) scope membership.
 * Returns the specific reason for a denial rather than a bare boolean, so
 * callers can log/respond with an actionable message.
 */
export type ApiKeyAuthDenialReason = "revoked" | "expired" | "ip_not_allowed" | "missing_scope";

export interface ApiKeyAuthResult {
  authorized: boolean;
  reason?: ApiKeyAuthDenialReason;
}

export function authorizeApiKeyRequest(
  key: ApiKey,
  request: { ipAddress: string; requiredScope?: string },
  now: Date = new Date(),
): ApiKeyAuthResult {
  if (key.status === "revoked") return { authorized: false, reason: "revoked" };
  if (key.status === "expired" || isExpired(key, now)) return { authorized: false, reason: "expired" };
  if (!isIpAllowed(key, request.ipAddress)) return { authorized: false, reason: "ip_not_allowed" };
  if (request.requiredScope && !hasScope(key, request.requiredScope)) {
    return { authorized: false, reason: "missing_scope" };
  }
  return { authorized: true };
}

/**
 * Heuristic compromise detection: flags a key whose usage suddenly spikes
 * far beyond its recent baseline, or whose recent requests originate from
 * an unusually high number of distinct IPs — either can indicate a leaked
 * key being used by an attacker alongside its legitimate owner.
 */
export interface CompromiseCheckInput {
  recentUsage: ApiKeyUsage[];
  baselineRequestsPerHour: number;
  /** Multiplier over baseline that triggers a spike flag. Defaults to 5. */
  spikeMultiplier?: number;
  /** Distinct-IP count within recentUsage that triggers a flag. Defaults to 5. */
  maxDistinctIps?: number;
}

export interface CompromiseCheckResult {
  suspicious: boolean;
  reasons: string[];
}

export function checkForCompromise(input: CompromiseCheckInput): CompromiseCheckResult {
  const reasons: string[] = [];
  const spikeMultiplier = input.spikeMultiplier ?? 5;
  const maxDistinctIps = input.maxDistinctIps ?? 5;

  if (input.recentUsage.length > input.baselineRequestsPerHour * spikeMultiplier) {
    reasons.push(
      `Request volume (${input.recentUsage.length}/hr) exceeds ${spikeMultiplier}x baseline (${input.baselineRequestsPerHour}/hr)`,
    );
  }

  const distinctIps = new Set(input.recentUsage.map((u) => u.ipAddress));
  if (distinctIps.size > maxDistinctIps) {
    reasons.push(`Requests originated from ${distinctIps.size} distinct IPs, exceeding threshold of ${maxDistinctIps}`);
  }

  return { suspicious: reasons.length > 0, reasons };
}
