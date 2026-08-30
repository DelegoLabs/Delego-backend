/**
 * Scope checking and enforcement utility
 * Issue #152
 */

import type { ApiKeyScope, ScopeCheckResult } from "@delegolabs/types";

interface ScopeCheckInput {
  resource: string;
  action: "read" | "write" | "delete" | "admin";
  scopes: ApiKeyScope[];
  conditions?: Record<string, unknown>;
  clientIp?: string;
  ipAllowlist: string[];
  ipDenylist: string[];
  validFrom: Date;
  validUntil?: Date | null;
  quota?: Record<string, {
    limit: number;
    window: string;
    used: number;
    resetAt: string;
  }>;
}

function isIpAllowed(ip: string, allowlist: string[], denylist: string[]): boolean {
  if (denylist.length > 0 && denylist.includes(ip)) {
    return false;
  }
  if (allowlist.length === 0) return true;
  return allowlist.includes(ip);
}

function isTimeBound(validFrom: Date, validUntil?: Date | null): boolean {
  const now = Date.now();
  if (now < validFrom.getTime()) return false;
  if (validUntil && now > validUntil.getTime()) return false;
  return true;
}

function checkQuota(
  resource: string,
  quota?: Record<string, { limit: number; window: string; used: number; resetAt: string }>
): { allowed: boolean; remaining?: number } {
  if (!quota || !quota[resource]) return { allowed: true };

  const q = quota[resource];
  const resetAt = Date.parse(q.resetAt);
  if (Date.now() > resetAt) return { allowed: true, remaining: q.limit };

  if (q.used >= q.limit) return { allowed: false, remaining: 0 };
  return { allowed: true, remaining: q.limit - q.used };
}

function matchConditions(
  requestConditions: Record<string, unknown>,
  scopeConditions?: Record<string, unknown>
): boolean {
  if (!scopeConditions || Object.keys(scopeConditions).length === 0) return true;

  for (const [key, expectedValue] of Object.entries(scopeConditions)) {
    const actualValue = requestConditions[key];
    if (actualValue === undefined) return false;
    if (typeof expectedValue === "string" && typeof actualValue === "string") {
      if (actualValue !== expectedValue) return false;
    } else if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
      return false;
    }
  }
  return true;
}

export function checkScope(input: ScopeCheckInput): ScopeCheckResult {
  if (!isTimeBound(input.validFrom, input.validUntil)) {
    return {
      allowed: false,
      reason: "API key is not valid for the current time",
    };
  }

  if (input.clientIp && !isIpAllowed(input.clientIp, input.ipAllowlist, input.ipDenylist)) {
    return {
      allowed: false,
      reason: "Client IP is not allowed",
    };
  }

  const matchingScope = input.scopes.find((scope) => {
    if (scope.resource !== input.resource && scope.resource !== "*") return false;
    if (!scope.actions.includes(input.action) && !scope.actions.includes("admin")) return false;
    if (!matchConditions(input.conditions ?? {}, scope.conditions)) return false;
    return true;
  });

  if (!matchingScope) {
    return {
      allowed: false,
      reason: `No matching scope for resource=${input.resource}, action=${input.action}`,
    };
  }

  const quotaCheck = checkQuota(input.resource, input.quota);
  if (!quotaCheck.allowed) {
    return {
      allowed: false,
      scope: matchingScope,
      reason: "Quota exceeded",
      quotaRemaining: 0,
    };
  }

  return {
    allowed: true,
    scope: matchingScope,
    quotaRemaining: quotaCheck.remaining,
  };
}

export function mergeScopes(
  parentScopes: ApiKeyScope[],
  childScopes: ApiKeyScope[]
): ApiKeyScope[] {
  const merged = new Map<string, ApiKeyScope>();

  for (const scope of parentScopes) {
    const key = `${scope.resource}:${scope.actions.sort().join(",")}`;
    merged.set(key, { ...scope });
  }

  for (const scope of childScopes) {
    const key = `${scope.resource}:${scope.actions.sort().join(",")}`;
    if (merged.has(key)) {
      const existing = merged.get(key)!;
      if (scope.conditions) {
        existing.conditions = { ...existing.conditions, ...scope.conditions };
      }
    } else {
      merged.set(key, { ...scope });
    }
  }

  return Array.from(merged.values());
}

export function generateApiKeyPrefix(name: string): string {
  const clean = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4);
  const random = Math.random().toString(36).slice(2, 6);
  return `${clean}_${random}`;
}
