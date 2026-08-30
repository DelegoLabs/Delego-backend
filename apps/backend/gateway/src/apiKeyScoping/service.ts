/**
 * API key management service
 * Issue #152
 */

import { randomBytes, createHash } from "node:crypto";
import { ScopedApiKey } from "../models/ScopedApiKey.js";
import { mergeScopes, generateApiKeyPrefix } from "./scopeChecker.js";
import type { ApiKeyScope, ScopedApiKey as ScopedApiKeyType, CreateApiKeyRequest } from "@delegolabs/types";

export interface ApiKeyCreateResult {
  key: ScopedApiKeyType;
  rawKey: string;
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function generateRawKey(): string {
  return `dlgo_${randomBytes(32).toString("hex")}`;
}

function modelToApiKey(model: ScopedApiKey): ScopedApiKeyType {
  return {
    id: model.id,
    name: model.name,
    prefix: model.prefix,
    hashedKey: model.hashedKey,
    scopes: model.scopes as ApiKeyScope[],
    inheritsFrom: model.inheritsFrom ?? undefined,
    ipAllowlist: model.ipAllowlist,
    ipDenylist: model.ipDenylist,
    validFrom: model.validFrom.toISOString(),
    validUntil: model.validUntil?.toISOString(),
    quota: model.quota as ScopedApiKeyType["quota"],
    status: model.status,
    createdAt: model.createdAt.toISOString(),
    lastUsedAt: model.lastUsedAt?.toISOString(),
  };
}

export async function createApiKey(
  _userId: string,
  request: CreateApiKeyRequest
): Promise<ApiKeyCreateResult> {
  const rawKey = generateRawKey();
  const hashedKey = hashKey(rawKey);
  const prefix = generateApiKeyPrefix(request.name);

  const now = new Date();
  const defaultQuota: ScopedApiKeyType["quota"] = {};
  for (const [resource, config] of Object.entries(request.quota ?? {})) {
    const resetWindow = config.window === "hour" ? 3600000
      : config.window === "day" ? 86400000
      : 2592000000;
    defaultQuota[resource] = {
      limit: config.limit,
      window: config.window,
      used: 0,
      resetAt: new Date(now.getTime() + resetWindow).toISOString(),
    };
  }

  const apiKey = await ScopedApiKey.create({
    name: request.name,
    prefix,
    hashedKey,
    scopes: request.scopes,
    ipAllowlist: request.ipAllowlist ?? [],
    ipDenylist: request.ipDenylist ?? [],
    validFrom: request.validFrom ? new Date(request.validFrom) : now,
    validUntil: request.validUntil ? new Date(request.validUntil) : null,
    quota: defaultQuota,
    status: "active",
  });

  return {
    key: modelToApiKey(apiKey),
    rawKey,
  };
}

export async function getApiKey(id: string): Promise<ScopedApiKeyType | null> {
  const apiKey = await ScopedApiKey.findByPk(id);
  return apiKey ? modelToApiKey(apiKey) : null;
}

export async function listApiKeys(userId?: string): Promise<ScopedApiKeyType[]> {
  const where = userId ? { /* userId filter */ } : {};
  const keys = await ScopedApiKey.findAll({ where });
  return keys.map(modelToApiKey);
}

export async function revokeApiKey(id: string): Promise<boolean> {
  const [affectedCount] = await ScopedApiKey.update(
    { status: "revoked" },
    { where: { id } }
  );
  return affectedCount > 0;
}

export async function suspendApiKey(id: string): Promise<boolean> {
  const [affectedCount] = await ScopedApiKey.update(
    { status: "suspended" },
    { where: { id } }
  );
  return affectedCount > 0;
}

export async function activateApiKey(id: string): Promise<boolean> {
  const [affectedCount] = await ScopedApiKey.update(
    { status: "active" },
    { where: { id, status: { ["in"]: ["suspended"] } } }
  );
  return affectedCount > 0;
}

export async function updateApiKeyScopes(
  id: string,
  scopes: ApiKeyScope[]
): Promise<ScopedApiKeyType | null> {
  const apiKey = await ScopedApiKey.findByPk(id);
  if (!apiKey) return null;

  const mergedScopes = apiKey.inheritsFrom
    ? await inheritScopes(apiKey.inheritsFrom, scopes)
    : scopes;

  await apiKey.update({ scopes: mergedScopes });
  return modelToApiKey(apiKey);
}

async function inheritScopes(
  parentId: string,
  childScopes: ApiKeyScope[]
): Promise<ApiKeyScope[]> {
  const parent = await ScopedApiKey.findByPk(parentId);
  if (!parent) return childScopes;
  return mergeScopes(parent.scopes as ApiKeyScope[], childScopes);
}

export async function incrementQuotaUsage(
  id: string,
  resource: string,
  amount: number = 1
): Promise<boolean> {
  const apiKey = await ScopedApiKey.findByPk(id);
  if (!apiKey) return false;

  const quota = apiKey.quota as Record<string, { limit: number; window: string; used: number; resetAt: string }>;
  const resourceQuota = quota[resource];

  if (!resourceQuota) return true;

  const resetAt = Date.parse(resourceQuota.resetAt);
  if (Date.now() > resetAt) {
    const resetWindow = resourceQuota.window === "hour" ? 3600000
      : resourceQuota.window === "day" ? 86400000
      : 2592000000;
    resourceQuota.used = 0;
    resourceQuota.resetAt = new Date(Date.now() + resetWindow).toISOString();
  }

  resourceQuota.used += amount;
  await apiKey.update({ quota, lastUsedAt: new Date() });
  return resourceQuota.used <= resourceQuota.limit;
}

export async function findApiKeyByPrefix(prefix: string): Promise<ScopedApiKeyType | null> {
  const apiKey = await ScopedApiKey.findOne({ where: { prefix } });
  return apiKey ? modelToApiKey(apiKey) : null;
}
