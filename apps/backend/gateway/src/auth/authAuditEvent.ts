import { createLogger } from "@delegolabs/utils";
import { getRedisClient } from "../rateLimit/redisClient.js";

const log = createLogger("gateway:auth:audit", process.env.LOG_LEVEL ?? "info");

/**
 * Internal audit event emitted by gateway auth routes.
 * Must never include passwords, refresh tokens, or access tokens.
 */
export interface AuthAuditEvent {
  userId?: string;
  email?: string;
  action: string;
  success: boolean;
  requestId: string;
  occurredAt: string;
}

/** Redis pub/sub channel for auth audit events (`gateway:auth:audit`). */
export const AUTH_AUDIT_CHANNEL = "gateway:auth:audit";
export const AUTH_AUDIT_STREAM_KEY = AUTH_AUDIT_CHANNEL;

export const AUTH_AUDIT_ACTIONS = {
  LOGIN: "login",
  REGISTER: "register",
  LOGOUT: "logout",
  REFRESH: "refresh",
  OAUTH_LOGIN: "oauth_login",
  OAUTH_REGISTER: "oauth_register",
  REVOKE_ALL_SESSIONS: "revoke_all_sessions",
} as const;

export interface AuthAuditRedisPublisher {
  publish(channel: string, message: string): Promise<unknown> | unknown;
}

export const publishedAuthAuditEvents: AuthAuditEvent[] = [];

let configuredRedisPublisher: AuthAuditRedisPublisher | null | undefined;

export function configureAuthAuditRedisPublisher(
  publisher: AuthAuditRedisPublisher | null | undefined,
): void {
  configuredRedisPublisher = publisher;
}

export function clearAuthAuditRedisPublisher(): void {
  configuredRedisPublisher = undefined;
}

export function clearPublishedAuthAuditEvents(): void {
  publishedAuthAuditEvents.length = 0;
}

export function resetAuthAuditStateForTests(): void {
  clearPublishedAuthAuditEvents();
  clearAuthAuditRedisPublisher();
}

function isTestEnvironment(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.MOCK_REDIS === "true" ||
    process.env.CI === "true" ||
    Object.keys(process.env).some((key) => key.includes("TEST"))
  );
}

function resolveRedisPublisher(): AuthAuditRedisPublisher | null {
  if (configuredRedisPublisher !== undefined) return configuredRedisPublisher;
  if (isTestEnvironment()) return null;
  return getRedisClient();
}

function recordInMemory(event: AuthAuditEvent): void {
  publishedAuthAuditEvents.push(event);
}

function logPublished(
  fullEvent: AuthAuditEvent,
  sink: "redis" | "memory",
): void {
  log.info("Auth audit event published", {
    sink,
    channel: AUTH_AUDIT_CHANNEL,
    streamKey: AUTH_AUDIT_STREAM_KEY,
    action: fullEvent.action,
    success: fullEvent.success,
    requestId: fullEvent.requestId,
    ...(fullEvent.userId ? { userId: fullEvent.userId } : {}),
  });
}

function fallbackToMemory(fullEvent: AuthAuditEvent, error: unknown): void {
  try {
    recordInMemory(fullEvent);
    log.error("Redis auth audit publish failed; using in-memory sink", {
      channel: AUTH_AUDIT_CHANNEL,
      action: fullEvent.action,
      requestId: fullEvent.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  } catch (fallbackErr) {
    log.error("Failed to record auth audit event in memory", {
      action: fullEvent.action,
      requestId: fullEvent.requestId,
      error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
    });
  }
}

/**
 * Publish an auth audit event. Failures are logged and never re-thrown so
 * audit plumbing cannot block authentication responses.
 */
export async function publishAuthAuditEvent(
  event: Omit<AuthAuditEvent, "occurredAt"> & { occurredAt?: string }
): Promise<void> {
  const fullEvent: AuthAuditEvent = {
    ...event,
    occurredAt: event.occurredAt ?? new Date().toISOString(),
  };

  let publisher: AuthAuditRedisPublisher | null;
  try {
    publisher = resolveRedisPublisher();
  } catch (err) {
    fallbackToMemory(fullEvent, err);
    return;
  }

  if (!publisher) {
    recordInMemory(fullEvent);
    logPublished(fullEvent, "memory");
    return;
  }

  try {
    await publisher.publish(AUTH_AUDIT_CHANNEL, JSON.stringify(fullEvent));
    logPublished(fullEvent, "redis");
  } catch (err) {
    fallbackToMemory(fullEvent, err);
  }
}
