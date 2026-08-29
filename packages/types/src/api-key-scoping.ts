/**
 * Fine-Grained API Key Scoping with Resource Permissions
 * Issue #152
 */

export interface ApiKeyScope {
  resource: string;
  actions: ("read" | "write" | "delete" | "admin")[];
  conditions?: Record<string, unknown>;
}

export interface ScopedApiKey {
  id: string;
  name: string;
  prefix: string;
  hashedKey: string;
  scopes: ApiKeyScope[];
  inheritsFrom?: string;
  ipAllowlist: string[];
  ipDenylist: string[];
  validFrom: string;
  validUntil?: string;
  quota: Record<
    string,
    {
      limit: number;
      window: "hour" | "day" | "month";
      used: number;
      resetAt: string;
    }
  >;
  status: "active" | "revoked" | "expired" | "suspended";
  createdAt: string;
  lastUsedAt?: string;
}

export interface ScopeCheckResult {
  allowed: boolean;
  scope?: ApiKeyScope;
  reason?: string;
  quotaRemaining?: number;
}

export interface CreateApiKeyRequest {
  name: string;
  scopes: ApiKeyScope[];
  ipAllowlist?: string[];
  ipDenylist?: string[];
  validFrom?: string;
  validUntil?: string;
  quota?: Record<
    string,
    {
      limit: number;
      window: "hour" | "day" | "month";
    }
  >;
}

export interface ApiKeyListResponse {
  keys: ScopedApiKey[];
  total: number;
}
