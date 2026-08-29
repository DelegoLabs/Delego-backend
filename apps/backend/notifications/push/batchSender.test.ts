/**
 * Tests for the multi-platform push batch sender (Issue #57).
 *
 * Providers are stubbed in-memory here — no real Web Push/FCM/APNs network
 * calls are made anywhere in this suite.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  PushBatchSender,
  InMemorySubscriptionStore,
  filterSubscriptionsByTopic,
} from "./batchSender.js";
import { PushDeliveryTracker } from "../src/deliveryTracker.js";
import type { PushNotification, PushProvider, PushSubscription, ProviderSendOutcome } from "./types.js";

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

/** Stub provider whose outcome is fully controlled by the test. */
class StubProvider implements PushProvider {
  public calls: Array<{ subscription: PushSubscription; notification: PushNotification }> = [];

  constructor(
    public readonly platform: PushSubscription["platform"],
    private readonly outcome: ProviderSendOutcome | (() => ProviderSendOutcome)
  ) {}

  async send(subscription: PushSubscription, notification: PushNotification): Promise<ProviderSendOutcome> {
    this.calls.push({ subscription, notification });
    return typeof this.outcome === "function" ? this.outcome() : this.outcome;
  }
}

describe("filterSubscriptionsByTopic", () => {
  it("returns only subscriptions subscribed to the given topic", () => {
    const subs = [
      makeSubscription({ id: "a", topics: ["news"] }),
      makeSubscription({ id: "b", topics: ["sports"] }),
      makeSubscription({ id: "c", topics: ["news", "sports"] }),
    ];

    expect(filterSubscriptionsByTopic(subs, "news").map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("returns an empty array when nothing matches", () => {
    const subs = [makeSubscription({ id: "a", topics: ["news"] })];
    expect(filterSubscriptionsByTopic(subs, "unknown-topic")).toEqual([]);
  });
});

describe("InMemorySubscriptionStore", () => {
  it("adds, gets, and removes subscriptions", async () => {
    const store = new InMemorySubscriptionStore();
    const sub = makeSubscription();
    store.add(sub);

    expect(await store.get(sub.id)).toEqual(sub);
    expect(store.has(sub.id)).toBe(true);

    await store.remove(sub.id);
    expect(await store.get(sub.id)).toBeNull();
    expect(store.has(sub.id)).toBe(false);
  });

  it("returns null for an unknown subscription id", async () => {
    const store = new InMemorySubscriptionStore();
    expect(await store.get("missing")).toBeNull();
  });
});

describe("PushBatchSender", () => {
  let store: InMemorySubscriptionStore;
  let tracker: PushDeliveryTracker;

  beforeEach(() => {
    store = new InMemorySubscriptionStore();
    tracker = new PushDeliveryTracker();
  });

  it("routes each subscription to its platform's provider and reports a sent summary", async () => {
    const webSub = makeSubscription({ id: "web-1", platform: "web" });
    const androidSub = makeSubscription({ id: "android-1", platform: "android", fcmToken: "tok" });
    store.add(webSub);
    store.add(androidSub);

    const webProvider = new StubProvider("web", { success: true, messageId: "web-msg-1" });
    const androidProvider = new StubProvider("android", { success: true, messageId: "fcm-msg-1" });

    const sender = new PushBatchSender({
      providers: [webProvider, androidProvider],
      subscriptions: store,
      tracker,
    });

    const result = await sender.send(
      makeNotification({ subscriptionIds: [webSub.id, androidSub.id] })
    );

    expect(result.notificationId).toBe("notif-1");
    expect(result.summary).toEqual({ sent: 2, failed: 0, invalidated: 0 });
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.success)).toBe(true);
    expect(webProvider.calls).toHaveLength(1);
    expect(androidProvider.calls).toHaveLength(1);
  });

  it("marks unknown subscription ids as failed without calling any provider", async () => {
    const webProvider = new StubProvider("web", { success: true });
    const sender = new PushBatchSender({ providers: [webProvider], subscriptions: store, tracker });

    const result = await sender.send(makeNotification({ subscriptionIds: ["does-not-exist"] }));

    expect(result.summary).toEqual({ sent: 0, failed: 1, invalidated: 0 });
    expect(result.results[0]).toMatchObject({ subscriptionId: "does-not-exist", success: false });
    expect(result.results[0].error).toMatch(/unknown subscription/i);
    expect(webProvider.calls).toHaveLength(0);
  });

  it("fails gracefully when no provider is registered for a subscription's platform", async () => {
    const iosSub = makeSubscription({ id: "ios-1", platform: "ios", apnsToken: "tok" });
    store.add(iosSub);

    // Only a web provider registered — no provider for "ios".
    const webProvider = new StubProvider("web", { success: true });
    const sender = new PushBatchSender({ providers: [webProvider], subscriptions: store, tracker });

    const result = await sender.send(makeNotification({ subscriptionIds: [iosSub.id] }));

    expect(result.summary).toEqual({ sent: 0, failed: 1, invalidated: 0 });
    expect(result.results[0].error).toMatch(/no push provider registered/i);
  });

  it("removes a subscription and reports it invalidated when the provider reports it invalid", async () => {
    const webSub = makeSubscription({ id: "web-1", platform: "web" });
    store.add(webSub);

    const webProvider = new StubProvider("web", {
      success: false,
      error: "410 Gone",
      invalid: true,
    });
    const sender = new PushBatchSender({ providers: [webProvider], subscriptions: store, tracker });

    const result = await sender.send(makeNotification({ subscriptionIds: [webSub.id] }));

    expect(result.summary).toEqual({ sent: 0, failed: 1, invalidated: 1 });
    expect(await store.get(webSub.id)).toBeNull();
  });

  it("does not remove a subscription on a transient (non-invalid) failure", async () => {
    const webSub = makeSubscription({ id: "web-1", platform: "web" });
    store.add(webSub);

    const webProvider = new StubProvider("web", { success: false, error: "503 Service Unavailable" });
    const sender = new PushBatchSender({ providers: [webProvider], subscriptions: store, tracker });

    const result = await sender.send(makeNotification({ subscriptionIds: [webSub.id] }));

    expect(result.summary).toEqual({ sent: 0, failed: 1, invalidated: 0 });
    expect(await store.get(webSub.id)).toEqual(webSub);
  });

  it("records a failure when the provider throws instead of returning an outcome", async () => {
    const webSub = makeSubscription({ id: "web-1", platform: "web" });
    store.add(webSub);

    class ThrowingProvider implements PushProvider {
      readonly platform = "web" as const;
      async send(): Promise<ProviderSendOutcome> {
        throw new Error("network exploded");
      }
    }

    const sender = new PushBatchSender({ providers: [new ThrowingProvider()], subscriptions: store, tracker });
    const result = await sender.send(makeNotification({ subscriptionIds: [webSub.id] }));

    expect(result.summary).toEqual({ sent: 0, failed: 1, invalidated: 0 });
    expect(result.results[0].error).toBe("network exploded");
  });

  it("sends to multiple subscriptions concurrently and preserves per-subscription results", async () => {
    const subs = [
      makeSubscription({ id: "s1", platform: "web" }),
      makeSubscription({ id: "s2", platform: "web" }),
      makeSubscription({ id: "s3", platform: "web" }),
    ];
    subs.forEach((s) => store.add(s));

    let callCount = 0;
    const provider = new StubProvider("web", () => {
      callCount += 1;
      // Every other call fails, to prove results map back to the right subscription.
      return callCount % 2 === 0
        ? { success: false, error: "boom" }
        : { success: true, messageId: `msg-${callCount}` };
    });

    const sender = new PushBatchSender({ providers: [provider], subscriptions: store, tracker });
    const result = await sender.send(makeNotification({ subscriptionIds: subs.map((s) => s.id) }));

    expect(result.results).toHaveLength(3);
    expect(result.summary.sent + result.summary.failed).toBe(3);
    // Each result corresponds to its own subscriptionId, in the requested order.
    expect(result.results.map((r) => r.subscriptionId)).toEqual(["s1", "s2", "s3"]);
  });

  it("uses the default shared delivery tracker when none is supplied", async () => {
    const webSub = makeSubscription({ id: "web-1", platform: "web" });
    store.add(webSub);
    const webProvider = new StubProvider("web", { success: true });

    const sender = new PushBatchSender({ providers: [webProvider], subscriptions: store });
    const result = await sender.send(makeNotification({ subscriptionIds: [webSub.id] }));

    expect(result.summary.sent).toBe(1);
  });
});
