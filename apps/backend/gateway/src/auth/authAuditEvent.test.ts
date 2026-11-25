import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  publishAuthAuditEvent,
  resetAuthAuditStateForTests,
  configureAuthAuditRedisPublisher,
  clearAuthAuditRedisPublisher,
  publishedAuthAuditEvents,
  AUTH_AUDIT_ACTIONS,
  AUTH_AUDIT_CHANNEL,
  AUTH_AUDIT_STREAM_KEY,
  type AuthAuditEvent,
} from "./authAuditEvent.js";

describe("publishAuthAuditEvent", () => {
  beforeEach(() => {
    resetAuthAuditStateForTests();
  });

  it("records a successful login audit payload", async () => {
    await publishAuthAuditEvent({
      action: AUTH_AUDIT_ACTIONS.LOGIN,
      success: true,
      requestId: "req-login-success",
      userId: "user-123",
      email: "user@example.com",
    });

    expect(publishedAuthAuditEvents).toHaveLength(1);
    expect(publishedAuthAuditEvents[0]).toEqual({
      action: "login",
      success: true,
      requestId: "req-login-success",
      userId: "user-123",
      email: "user@example.com",
      occurredAt: expect.any(String),
    } satisfies AuthAuditEvent);
  });

  it("records a failed login audit payload without userId", async () => {
    await publishAuthAuditEvent({
      action: AUTH_AUDIT_ACTIONS.LOGIN,
      success: false,
      requestId: "req-login-failure",
      email: "unknown@example.com",
    });

    expect(publishedAuthAuditEvents).toHaveLength(1);
    expect(publishedAuthAuditEvents[0]).toMatchObject({
      action: "login",
      success: false,
      requestId: "req-login-failure",
      email: "unknown@example.com",
    });
    expect(publishedAuthAuditEvents[0]?.userId).toBeUndefined();
  });

  it("does not include password or token fields in published events", async () => {
    await publishAuthAuditEvent({
      action: AUTH_AUDIT_ACTIONS.REGISTER,
      success: true,
      requestId: "req-register-success",
      userId: "user-456",
      email: "new@example.com",
    });

    const event = publishedAuthAuditEvents[0] as Record<string, unknown>;
    expect(Object.keys(event).sort()).toEqual([
      "action",
      "email",
      "occurredAt",
      "requestId",
      "success",
      "userId",
    ]);
    expect(event).not.toHaveProperty("password");
    expect(event).not.toHaveProperty("accessToken");
    expect(event).not.toHaveProperty("refreshToken");
    expect(event).not.toHaveProperty("token");
  });

  it("uses the Redis channel as the audit stream key", () => {
    expect(AUTH_AUDIT_CHANNEL).toBe("gateway:auth:audit");
    expect(AUTH_AUDIT_STREAM_KEY).toBe(AUTH_AUDIT_CHANNEL);
  });

  it("publishes the serialized event to Redis and skips the in-memory sink", async () => {
    const publish = vi.fn().mockResolvedValue(1);
    configureAuthAuditRedisPublisher({ publish });

    await publishAuthAuditEvent({
      action: AUTH_AUDIT_ACTIONS.LOGIN,
      success: true,
      requestId: "req-redis-login",
      userId: "user-789",
      occurredAt: "2026-11-24T10:20:30.000Z",
    });

    expect(publish).toHaveBeenCalledTimes(1);
    const [channel, message] = publish.mock.calls[0] as [string, string];
    expect(channel).toBe(AUTH_AUDIT_CHANNEL);
    expect(JSON.parse(message)).toEqual({
      action: "login",
      success: true,
      requestId: "req-redis-login",
      userId: "user-789",
      occurredAt: "2026-11-24T10:20:30.000Z",
    } satisfies AuthAuditEvent);
    expect(publishedAuthAuditEvents).toHaveLength(0);
  });

  it("falls back to the in-memory sink when no Redis publisher is configured", async () => {
    clearAuthAuditRedisPublisher();

    await publishAuthAuditEvent({
      action: AUTH_AUDIT_ACTIONS.LOGOUT,
      success: true,
      requestId: "req-memory-logout",
    });

    expect(publishedAuthAuditEvents).toHaveLength(1);
    expect(publishedAuthAuditEvents[0]).toMatchObject({
      action: "logout",
      success: true,
      requestId: "req-memory-logout",
    });
  });

  it("falls back to the in-memory sink when Redis publishing fails", async () => {
    const publish = vi.fn().mockRejectedValue(new Error("redis unavailable"));
    configureAuthAuditRedisPublisher({ publish });

    await expect(
      publishAuthAuditEvent({
        action: AUTH_AUDIT_ACTIONS.REFRESH,
        success: false,
        requestId: "req-redis-failure",
      }),
    ).resolves.toBeUndefined();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publishedAuthAuditEvents).toHaveLength(1);
    expect(publishedAuthAuditEvents[0]).toMatchObject({
      action: "refresh",
      success: false,
      requestId: "req-redis-failure",
    });
  });

  it("forces the in-memory sink when a null publisher is configured", async () => {
    const publish = vi.fn();
    configureAuthAuditRedisPublisher({ publish });
    configureAuthAuditRedisPublisher(null);

    await publishAuthAuditEvent({
      action: AUTH_AUDIT_ACTIONS.OAUTH_LOGIN,
      success: true,
      requestId: "req-null-publisher",
    });

    expect(publish).not.toHaveBeenCalled();
    expect(publishedAuthAuditEvents).toHaveLength(1);
  });
});
