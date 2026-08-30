/**
 * Redis-backed session store (Issue #72): secure random IDs, sliding TTL,
 * rotation on privilege change, and a concurrent-session cap per user.
 *
 * Redis key schema:
 *   session:{id}          → JSON-serialized Session, TTL matches ttlSeconds
 *   session:user:{userId} → SET of active session ids for that user
 *
 * Out of scope for this change (left as follow-ups): field-level encryption
 * of sensitive session data, cross-node clustering beyond what Redis itself
 * provides, and session analytics aggregation — this module owns
 * create/read/rotate/invalidate; a separate reporting layer can read the
 * per-user session set for analytics without needing changes here.
 */

import { randomBytes } from "node:crypto";

/** Minimal subset of the ioredis client API this module depends on. */
export interface SessionRedisClient {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<number>;
}

export interface Session {
  id: string;
  userId: string;
  data: Record<string, unknown>;
  createdAt: string;
  lastAccessedAt: string;
  expiresAt: string;
  ipAddress: string;
  userAgent: string;
  deviceFingerprint: string;
  isElevated: boolean;
  rotatedFrom?: string;
}

export interface SessionConfig {
  ttlSeconds: number;
  slidingTtl: boolean;
  maxConcurrentSessions: number;
}

export interface CreateSessionInput {
  userId: string;
  ipAddress: string;
  userAgent: string;
  deviceFingerprint: string;
  data?: Record<string, unknown>;
  isElevated?: boolean;
}

const DEFAULT_CONFIG: SessionConfig = {
  ttlSeconds: 60 * 60 * 24, // 24h
  slidingTtl: true,
  maxConcurrentSessions: 5,
};

function sessionKey(id: string): string {
  return `session:${id}`;
}

function userSessionsKey(userId: string): string {
  return `session:user:${userId}`;
}

function generateSessionId(): string {
  return randomBytes(32).toString("base64url");
}

export class RedisSessionStore {
  private readonly config: SessionConfig;

  constructor(
    private readonly redis: SessionRedisClient,
    config: Partial<SessionConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Creates a new session, enforcing `maxConcurrentSessions` by evicting the
   * oldest session for that user first if the cap would otherwise be
   * exceeded (checked, not perfectly atomic across the enforce+create pair
   * under extreme concurrency — acceptable since the cap is a UX/security
   * guard, not a hard invariant that must never be exceeded by one).
   */
  async create(input: CreateSessionInput): Promise<Session> {
    await this.enforceConcurrentLimit(input.userId);

    const now = new Date();
    const id = generateSessionId();
    const session: Session = {
      id,
      userId: input.userId,
      data: input.data ?? {},
      createdAt: now.toISOString(),
      lastAccessedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.config.ttlSeconds * 1000).toISOString(),
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      deviceFingerprint: input.deviceFingerprint,
      isElevated: input.isElevated ?? false,
    };

    await this.redis.set(sessionKey(id), JSON.stringify(session), "EX", this.config.ttlSeconds);
    await this.redis.sadd(userSessionsKey(input.userId), id);
    await this.redis.expire(userSessionsKey(input.userId), this.config.ttlSeconds);

    return session;
  }

  /**
   * Reads a session. When `slidingTtl` is enabled, this extends the
   * session's expiry and bumps `lastAccessedAt` — call this on every
   * authenticated request, not just at login.
   */
  async get(id: string): Promise<Session | null> {
    const raw = await this.redis.get(sessionKey(id));
    if (!raw) return null;

    const session = JSON.parse(raw) as Session;

    if (this.config.slidingTtl) {
      session.lastAccessedAt = new Date().toISOString();
      session.expiresAt = new Date(Date.now() + this.config.ttlSeconds * 1000).toISOString();
      await this.redis.set(sessionKey(id), JSON.stringify(session), "EX", this.config.ttlSeconds);
    }

    return session;
  }

  /**
   * Rotates a session on privilege change (e.g. re-authentication, MFA
   * step-up): issues a new session id carrying the same user/data, marks it
   * elevated, and invalidates the old id so a stolen pre-elevation session
   * id can't be replayed after elevation.
   */
  async rotate(oldId: string): Promise<Session | null> {
    const existing = await this.redis.get(sessionKey(oldId));
    if (!existing) return null;
    const old = JSON.parse(existing) as Session;

    const now = new Date();
    const rotated: Session = {
      ...old,
      id: generateSessionId(),
      isElevated: true,
      createdAt: old.createdAt,
      lastAccessedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.config.ttlSeconds * 1000).toISOString(),
      rotatedFrom: oldId,
    };

    await this.redis.set(sessionKey(rotated.id), JSON.stringify(rotated), "EX", this.config.ttlSeconds);
    await this.redis.sadd(userSessionsKey(rotated.userId), rotated.id);
    await this.invalidate(oldId);

    return rotated;
  }

  /** Invalidates a single session (logout). */
  async invalidate(id: string): Promise<void> {
    const raw = await this.redis.get(sessionKey(id));
    await this.redis.del(sessionKey(id));
    if (raw) {
      const session = JSON.parse(raw) as Session;
      await this.redis.srem(userSessionsKey(session.userId), id);
    }
  }

  /** Invalidates every active session for a user (e.g. password change). */
  async invalidateAllForUser(userId: string): Promise<number> {
    const ids = await this.redis.smembers(userSessionsKey(userId));
    if (ids.length === 0) return 0;
    await this.redis.del(...ids.map(sessionKey));
    await this.redis.del(userSessionsKey(userId));
    return ids.length;
  }

  async listActiveForUser(userId: string): Promise<Session[]> {
    const ids = await this.redis.smembers(userSessionsKey(userId));
    const sessions: Session[] = [];
    for (const id of ids) {
      const raw = await this.redis.get(sessionKey(id));
      if (raw) sessions.push(JSON.parse(raw) as Session);
    }
    return sessions;
  }

  private async enforceConcurrentLimit(userId: string): Promise<void> {
    const ids = await this.redis.smembers(userSessionsKey(userId));
    if (ids.length < this.config.maxConcurrentSessions) return;

    const sessions = await this.listActiveForUser(userId);
    const oldest = sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (oldest) {
      await this.invalidate(oldest.id);
    }
  }
}
