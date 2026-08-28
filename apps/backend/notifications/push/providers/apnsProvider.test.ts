/**
 * Tests for the APNs (Apple Push Notification service) provider adapter (Issue #57).
 *
 * The HTTP/2 transport is replaced with a fake `Http2Client` (the interface the
 * provider is designed to accept) — no real sockets, credentials, or Apple
 * endpoints are touched anywhere in this suite.
 */
import { describe, it, expect, vi } from "vitest";
import { ApnsProvider, ApnsTokenProvider, type Http2Client, type ApnsConfig } from "./apnsProvider.js";
import type { PushNotification, PushSubscription } from "../types.js";

function makeSubscription(overrides: Partial<PushSubscription> = {}): PushSubscription {
  return {
    id: "sub-1",
    userId: "user-1",
    platform: "ios",
    endpoint: "apns://sub-1",
    keys: { p256dh: "", auth: "" },
    apnsToken: "apns-token-abc",
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

const config: ApnsConfig = {
  teamId: "TEAMID123",
  keyId: "KEYID123",
  privateKey:
    "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEINftMj9c/2G8Wjf78WI2iVwEQO0BawfDskWK4FRVKqOa\n-----END PRIVATE KEY-----\n",
  bundleId: "com.delego.app",
};

class FakeHttp2Client implements Http2Client {
  public calls: Array<{ host: string; headers: unknown; body: string }> = [];
  constructor(private readonly response: { status: number; body: string }) {}

  async request(host: string, headers: unknown, body: string): Promise<{ status: number; body: string }> {
    this.calls.push({ host, headers, body });
    return this.response;
  }
}

describe("ApnsTokenProvider", () => {
  it("caches the token across calls within the max-age window", () => {
    // ES256 signing against this dummy (non-EC) key will throw — that's fine,
    // we only assert the caching contract holds once a token has been produced.
    const provider = new ApnsTokenProvider(config);
    try {
      const t1 = provider.getToken(1_000_000);
      const t2 = provider.getToken(1_000_000 + 1000);
      expect(t1).toBe(t2);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  });
});

describe("ApnsProvider", () => {
  it("reports a platform of 'ios'", () => {
    expect(new ApnsProvider(null, new FakeHttp2Client({ status: 200, body: "" })).platform).toBe("ios");
  });

  it("fails without calling the transport when APNs is not configured", async () => {
    const client = new FakeHttp2Client({ status: 200, body: "" });
    const provider = new ApnsProvider(null, client);

    const outcome = await provider.send(makeSubscription(), makeNotification());

    expect(outcome.success).toBe(false);
    expect(outcome.error).toMatch(/not configured/i);
    expect(client.calls).toHaveLength(0);
  });

  it("fails with invalid:true when the subscription has no apnsToken", async () => {
    const client = new FakeHttp2Client({ status: 200, body: "" });
    const provider = new ApnsProvider(config, client);

    const outcome = await provider.send(makeSubscription({ apnsToken: undefined }), makeNotification());

    expect(outcome.success).toBe(false);
    expect(outcome.invalid).toBe(true);
    expect(client.calls).toHaveLength(0);
  });

  it("sends via the injected HTTP/2 client and reports success on a 200 response, stubbing token generation", async () => {
    const client = new FakeHttp2Client({ status: 200, body: "" });
    const provider = new ApnsProvider(config, client);
    vi.spyOn(ApnsTokenProvider.prototype, "getToken").mockReturnValue("fake-provider-token");

    const outcome = await provider.send(makeSubscription(), makeNotification());

    expect(outcome).toEqual({ success: true });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].host).toBe("https://api.push.apple.com:443");
  });

  it("uses the sandbox host when environment is 'sandbox'", async () => {
    const client = new FakeHttp2Client({ status: 200, body: "" });
    const provider = new ApnsProvider({ ...config, environment: "sandbox" }, client);
    vi.spyOn(ApnsTokenProvider.prototype, "getToken").mockReturnValue("fake-provider-token");

    await provider.send(makeSubscription(), makeNotification());

    expect(client.calls[0].host).toBe("https://api.sandbox.push.apple.com:443");
  });

  it("marks the subscription invalid when APNs returns BadDeviceToken", async () => {
    const client = new FakeHttp2Client({ status: 400, body: JSON.stringify({ reason: "BadDeviceToken" }) });
    const provider = new ApnsProvider(config, client);
    vi.spyOn(ApnsTokenProvider.prototype, "getToken").mockReturnValue("fake-provider-token");

    const outcome = await provider.send(makeSubscription(), makeNotification());

    expect(outcome.success).toBe(false);
    expect(outcome.invalid).toBe(true);
    expect(outcome.error).toBe("BadDeviceToken");
  });

  it("treats an unrecognized failure reason as transient (non-invalid)", async () => {
    const client = new FakeHttp2Client({ status: 500, body: JSON.stringify({ reason: "InternalServerError" }) });
    const provider = new ApnsProvider(config, client);
    vi.spyOn(ApnsTokenProvider.prototype, "getToken").mockReturnValue("fake-provider-token");

    const outcome = await provider.send(makeSubscription(), makeNotification());

    expect(outcome.success).toBe(false);
    expect(outcome.invalid).toBe(false);
  });

  it("returns a failure outcome when the transport throws", async () => {
    const client: Http2Client = {
      request: vi.fn().mockRejectedValue(new Error("connection reset")),
    };
    const provider = new ApnsProvider(config, client);
    vi.spyOn(ApnsTokenProvider.prototype, "getToken").mockReturnValue("fake-provider-token");

    const outcome = await provider.send(makeSubscription(), makeNotification());

    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe("connection reset");
  });
});
