/**
 * Redis distributed-lock primitives (SET NX PX + owner-checked Lua).
 *
 * Same contract as payments `RELEASE_LOCK_LUA` (delete only if the token/owner
 * matches), plus acquire-with-fence and renew. Cluster-safe when lock keys use
 * hash tags so related keys land on one slot.
 */

import type { CacheRedisClient } from "./client.js";

export interface RedisLockPayload {
  owner: string;
  acquiredAt: string;
  expiresAt: string;
  fence: number;
  metadata: Record<string, unknown>;
}

const ACQUIRE_LUA = `
local fence = redis.call("INCR", KEYS[2])
local payload = string.format(ARGV[1], fence)
local ok = redis.call("SET", KEYS[1], payload, "NX", "PX", tonumber(ARGV[2]))
if ok then
  return payload
end
return redis.call("GET", KEYS[1])
`;

/** Token-checked delete — same dialect as payments validation RELEASE_LOCK_LUA. */
const RELEASE_LUA = `
local current = redis.call("GET", KEYS[1])
if not current then
  return 0
end
local prefix = '{"owner":"' .. ARGV[1] .. '"'
if string.sub(current, 1, #prefix) == prefix then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const RENEW_LUA = `
local current = redis.call("GET", KEYS[1])
if not current then
  return -2
end
local prefix = '{"owner":"' .. ARGV[1] .. '"'
if string.sub(current, 1, #prefix) ~= prefix then
  return -1
end
redis.call("SET", KEYS[1], ARGV[3], "PX", tonumber(ARGV[2]))
return 1
`;

export function workflowLockKey(sagaId: string): string {
  return `lock:wf:{workflow:${sagaId}}`;
}

export function stepLockKey(sagaId: string, stepName: string): string {
  return `lock:step:{workflow:${sagaId}}:${stepName}`;
}

export function fenceKeyFor(lockKey: string): string {
  return `lock:fence:${lockKey}`;
}

export function serializeLockPayload(payload: RedisLockPayload): string {
  return JSON.stringify({
    owner: payload.owner,
    acquiredAt: payload.acquiredAt,
    expiresAt: payload.expiresAt,
    fence: payload.fence,
    metadata: payload.metadata,
  });
}

export function parseLockPayload(raw: string | null): RedisLockPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RedisLockPayload;
    if (typeof parsed.owner !== "string" || typeof parsed.fence !== "number") return null;
    return {
      owner: parsed.owner,
      acquiredAt: String(parsed.acquiredAt ?? ""),
      expiresAt: String(parsed.expiresAt ?? ""),
      fence: parsed.fence,
      metadata: parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata : {},
    };
  } catch {
    return null;
  }
}

function payloadTemplate(owner: string, acquiredAt: string, expiresAt: string, metadata: Record<string, unknown>): string {
  return serializeLockPayload({
    owner,
    acquiredAt,
    expiresAt,
    fence: 0,
    metadata,
  }).replace('"fence":0', '"fence":%d');
}

export async function redisLockAcquire(
  client: CacheRedisClient,
  lockKey: string,
  owner: string,
  ttlMs: number,
  metadata: Record<string, unknown> = {},
): Promise<{ acquired: boolean; payload: RedisLockPayload | null }> {
  const now = Date.now();
  const template = payloadTemplate(owner, new Date(now).toISOString(), new Date(now + ttlMs).toISOString(), metadata);
  const raw = await client.eval(ACQUIRE_LUA, 2, lockKey, fenceKeyFor(lockKey), template, ttlMs);
  const payload = parseLockPayload(typeof raw === "string" ? raw : raw == null ? null : String(raw));
  if (!payload) return { acquired: false, payload: null };
  return { acquired: payload.owner === owner, payload };
}

export async function redisLockRelease(client: CacheRedisClient, lockKey: string, owner: string): Promise<boolean> {
  const result = await client.eval(RELEASE_LUA, 1, lockKey, owner);
  return Number(result) === 1;
}

export type RedisLockRenewResult = "ok" | "stolen" | "missing";

export async function redisLockRenew(
  client: CacheRedisClient,
  lockKey: string,
  owner: string,
  ttlMs: number,
  metadata: Record<string, unknown>,
  fence: number,
): Promise<RedisLockRenewResult> {
  const now = Date.now();
  const payload = serializeLockPayload({
    owner,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    fence,
    metadata,
  });
  const result = Number(await client.eval(RENEW_LUA, 1, lockKey, owner, ttlMs, payload));
  if (result === 1) return "ok";
  if (result === -1) return "stolen";
  return "missing";
}

export async function redisLockInspect(
  client: CacheRedisClient,
  lockKey: string,
): Promise<{ payload: RedisLockPayload | null; pttlMs: number }> {
  const [raw, pttlMs] = await Promise.all([client.get(lockKey), client.pttl(lockKey)]);
  return { payload: parseLockPayload(raw), pttlMs };
}

export async function redisLockScan(
  client: CacheRedisClient,
  match: string,
  limit: number,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | number = "0";
  do {
    const [next, batch] = await client.scan(cursor, "MATCH", match, "COUNT", "50");
    cursor = next;
    for (const key of batch) {
      keys.push(key);
      if (keys.length >= limit) return keys;
    }
  } while (String(cursor) !== "0");
  return keys;
}
