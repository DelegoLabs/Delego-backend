/**
 * Tests for the Web Push (VAPID) provider adapter (Issue #57).
 *
 * `web-push`'s sendNotification is mocked at the module level — no real
 * network calls or VAPID credentials are used.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendNotificationMock = vi.fn();

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: (...args: unknown[]) => sendNotificationMock(...args),
  },
}));

import type { PushNotification, PushSubscription } from "../types.js";

function makeSubscription(overrides: Partial<PushSubscription> = {}): PushSubscription {
  return {
    id: "sub-1",
    userId: "user-1",
    platform: "web",
    endpoint: "https://push.example.com/sub-1",
    keys: { p256dh: "p256dh-key", auth: "auth-key" },
    topics: [],
    createdAt: new Date(0).toISOString(),
    lastUsedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function makeNotification(overrides: Partial<PushNotification> = {}): PushNotification {
  return {
    id: "notif-1",
    subscriptionIds: [],
    title: "Hello",
    body: "World",
    data: {},
    requireInteraction: false,
    ttlSeconds: 60,
    ...overrides,
  };
}

describe("WebPushProvider", () => {
  const originalPublic = process.env.VAPID_PUBLIC_KEY;
  const originalPrivate = process.env.VAPID_PRIVATE_KEY;

  beforeEach(() => {
    vi.resetModules();
    sendNotificationMock.mockReset();
    process.env.VAPID_PUBLIC_KEY = "test-public-key";
    process.env.VAPID_PRIVATE_KEY = "test-private-key";
  });

  afterEach(() => {
    process.env.VAPID_PUBLIC_KEY = originalPublic;
    process.env.VAPID_PRIVATE_KEY = originalPrivate;
  });

  it("reports a platform of 'web'", async () => {
    const { WebPushProvider } = await import("./webPushProvider.js");
    expect(new WebPushProvider().platform).toBe("web");
  });

  it("sends via web-push and returns a success outcome with a derived messageId", async () => {
    sendNotificationMock.mockResolvedValue({ statusCode: 201 });
    const { WebPushProvider } = await import("./webPushProvider.js");
    const provider = new WebPushProvider();

    const outcome = await provider.send(makeSubscription(), makeNotification());

    expect(outcome).toEqual({ success: true, messageId: "web-push-201" });
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("returns invalid:true without calling web-push when keys are missing", async () => {
    const { WebPushProvider } = await import("./webPushProvider.js");
    const provider = new WebPushProvider();

    const outcome = await provider.send(
      makeSubscription({ keys: { p256dh: "", auth: "" } }),
      makeNotification()
    );

    expect(outcome.success).toBe(false);
    expect(outcome.invalid).toBe(true);
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("marks the subscription invalid on a 410 Gone error", async () => {
    sendNotificationMock.mockRejectedValue(Object.assign(new Error("Gone"), { statusCode: 410 }));
    const { WebPushProvider } = await import("./webPushProvider.js");
    const provider = new WebPushProvider();

    const outcome = await provider.send(makeSubscription(), makeNotification());

    expect(outcome.success).toBe(false);
    expect(outcome.invalid).toBe(true);
  });

  it("marks the subscription invalid on a 404 Not Found error", async () => {
    sendNotificationMock.mockRejectedValue(Object.assign(new Error("Not Found"), { statusCode: 404 }));
    const { WebPushProvider } = await import("./webPushProvider.js");
    const provider = new WebPushProvider();

    const outcome = await provider.send(makeSubscription(), makeNotification());

    expect(outcome.invalid).toBe(true);
  });

  it("treats a non-404/410 error as a transient failure, not invalid", async () => {
    sendNotificationMock.mockRejectedValue(Object.assign(new Error("Service Unavailable"), { statusCode: 503 }));
    const { WebPushProvider } = await import("./webPushProvider.js");
    const provider = new WebPushProvider();

    const outcome = await provider.send(makeSubscription(), makeNotification());

    expect(outcome.success).toBe(false);
    expect(outcome.invalid).toBe(false);
    expect(outcome.error).toBe("Service Unavailable");
  });

  it("fails without calling web-push when VAPID keys are not configured", async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    const { WebPushProvider } = await import("./webPushProvider.js");
    const provider = new WebPushProvider();

    const outcome = await provider.send(makeSubscription(), makeNotification());

    expect(outcome.success).toBe(false);
    expect(outcome.error).toMatch(/VAPID/i);
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });
});
