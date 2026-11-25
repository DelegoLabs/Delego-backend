import { describe, it, expect, vi, beforeEach } from "vitest";

const sendEmailWithRetry = vi.fn();
const sendPushNotification = vi.fn();
const cleanupPushSubscriptions = vi.fn();
const recordPushDeliveryFailure = vi.fn();
const checkAndMarkDispatched = vi.fn();

const redisMock = {
  sadd: vi.fn(),
  srem: vi.fn(),
  smembers: vi.fn(),
};

vi.mock("@delegolabs/utils", () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../email/index.js", () => ({
  sendEmailWithRetry: (...args: unknown[]) => sendEmailWithRetry(...args),
}));

vi.mock("../push/index.js", () => {
  const parse = (raw: string) => JSON.parse(raw);
  const serialize = (t: unknown) => JSON.stringify(t);
  return {
    sendPushNotification: (...args: unknown[]) => sendPushNotification(...args),
    cleanupPushSubscriptions: (...args: unknown[]) =>
      cleanupPushSubscriptions(...args),
    parseTrackedPushSubscription: parse,
    serializeTrackedPushSubscription: serialize,
    recordPushDeliveryFailure: (...args: unknown[]) =>
      recordPushDeliveryFailure(...args),
    recordPushDeliveryFailureStub: undefined,
  };
});

vi.mock("./idempotency.js", () => ({
  checkAndMarkDispatched: (...args: unknown[]) =>
    checkAndMarkDispatched(...args),
}));

vi.mock("./redis/client.js", () => ({
  getDispatcherClient: () => redisMock,
}));

const {
  dispatchTransactionApproval,
  savePushSubscription,
  removePushSubscription,
  cleanupUserPushSubscriptions,
} = await import("./dispatcher.js");

const baseNotification = {
  userId: "user-1",
  email: "user@example.com",
  transactionId: "tx-1",
  amount: "$10",
  merchant: "Shop",
  approvalUrl: "https://app.test/approve/tx-1",
};

const makeSub = (endpoint: string) => ({
  endpoint,
  keys: { p256dh: "p", auth: "a" },
});

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.smembers.mockResolvedValue([]);
  redisMock.sadd.mockResolvedValue(1);
  redisMock.srem.mockResolvedValue(1);
  sendEmailWithRetry.mockResolvedValue(undefined);
  sendPushNotification.mockResolvedValue(undefined);
  checkAndMarkDispatched.mockResolvedValue(true);
});

describe("savePushSubscription", () => {
  it("stores a tracked subscription with zero failures", async () => {
    await savePushSubscription("user-1", makeSub("ep-1"));
    expect(redisMock.sadd).toHaveBeenCalledTimes(1);
    const [key, raw] = redisMock.sadd.mock.calls[0];
    expect(key).toBe("push:subscriptions:user-1");
    const stored = JSON.parse(raw);
    expect(stored.subscription.endpoint).toBe("ep-1");
    expect(stored.failureCount).toBe(0);
  });

  it("removes an existing member for the same endpoint before adding", async () => {
    const existing = JSON.stringify({
      subscription: makeSub("ep-1"),
      failureCount: 2,
      createdAt: 1,
    });
    redisMock.smembers.mockResolvedValue([existing]);
    await savePushSubscription("user-1", makeSub("ep-1"));
    expect(redisMock.srem).toHaveBeenCalledWith(
      "push:subscriptions:user-1",
      existing
    );
    expect(redisMock.sadd).toHaveBeenCalled();
  });
});

describe("removePushSubscription", () => {
  it("removes only the member matching the endpoint", async () => {
    const a = JSON.stringify({
      subscription: makeSub("ep-a"),
      failureCount: 0,
      createdAt: 1,
    });
    const b = JSON.stringify({
      subscription: makeSub("ep-b"),
      failureCount: 0,
      createdAt: 1,
    });
    redisMock.smembers.mockResolvedValue([a, b]);
    await removePushSubscription("user-1", "ep-b");
    expect(redisMock.srem).toHaveBeenCalledTimes(1);
    expect(redisMock.srem).toHaveBeenCalledWith("push:subscriptions:user-1", b);
  });
});

describe("cleanupUserPushSubscriptions", () => {
  it("rewrites the set with retained subscriptions and returns the result", async () => {
    const raw = JSON.stringify({
      subscription: makeSub("ep-1"),
      failureCount: 0,
      createdAt: 1,
    });
    redisMock.smembers.mockResolvedValue([raw]);
    const retained = [{ subscription: makeSub("ep-1"), failureCount: 0, createdAt: 1 }];
    const result = { scanned: 1, removed: 0, failed: 0 };
    cleanupPushSubscriptions.mockReturnValue({ result, retained, removed: [] });

    const out = await cleanupUserPushSubscriptions("user-1");

    expect(out).toEqual(result);
    expect(redisMock.srem).toHaveBeenCalledWith("push:subscriptions:user-1", raw);
    expect(redisMock.sadd).toHaveBeenCalledWith(
      "push:subscriptions:user-1",
      JSON.stringify(retained[0])
    );
  });

  it("does not re-add anything when all subscriptions are removed", async () => {
    redisMock.smembers.mockResolvedValue([
      JSON.stringify({ subscription: makeSub("ep-1"), failureCount: 9, createdAt: 1 }),
    ]);
    const result = { scanned: 1, removed: 1, failed: 0 };
    cleanupPushSubscriptions.mockReturnValue({
      result,
      retained: [],
      removed: [{}],
    });

    const out = await cleanupUserPushSubscriptions("user-1");

    expect(out).toEqual(result);
    expect(redisMock.sadd).not.toHaveBeenCalled();
  });
});

describe("dispatchTransactionApproval", () => {
  it("sends email when recipient is present and no eventId is given", async () => {
    await dispatchTransactionApproval(baseNotification);
    expect(sendEmailWithRetry).toHaveBeenCalledTimes(1);
    const [job, subject] = sendEmailWithRetry.mock.calls[0];
    expect(job.recipient).toBe("user@example.com");
    expect(job.templateName).toBe("approval-request");
    expect(subject).toBe("Purchase Approval Required");
    expect(checkAndMarkDispatched).not.toHaveBeenCalled();
  });

  it("skips email when no email address is provided", async () => {
    await dispatchTransactionApproval({ ...baseNotification, email: undefined });
    expect(sendEmailWithRetry).not.toHaveBeenCalled();
  });

  it("sends push to every stored subscription", async () => {
    const a = JSON.stringify({ subscription: makeSub("ep-a"), failureCount: 0, createdAt: 1 });
    const b = JSON.stringify({ subscription: makeSub("ep-b"), failureCount: 0, createdAt: 1 });
    redisMock.smembers.mockResolvedValue([a, b]);

    await dispatchTransactionApproval(baseNotification);

    expect(sendPushNotification).toHaveBeenCalledTimes(2);
    const endpoints = sendPushNotification.mock.calls.map((c) => c[0].endpoint);
    expect(endpoints).toEqual(["ep-a", "ep-b"]);
  });

  it("deduplicates email and push when eventId repeats", async () => {
    const raw = JSON.stringify({ subscription: makeSub("ep-a"), failureCount: 0, createdAt: 1 });
    redisMock.smembers.mockResolvedValue([raw]);
    checkAndMarkDispatched.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await dispatchTransactionApproval(baseNotification, "evt-1");

    expect(checkAndMarkDispatched).toHaveBeenCalledWith(redisMock, {
      userId: "user-1",
      channel: "email",
      eventType: "transaction_approval",
      eventId: "evt-1",
    });
    expect(sendEmailWithRetry).toHaveBeenCalledTimes(1);
    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("suppresses all channels when the event was already dispatched", async () => {
    const raw = JSON.stringify({ subscription: makeSub("ep-a"), failureCount: 0, createdAt: 1 });
    redisMock.smembers.mockResolvedValue([raw]);
    checkAndMarkDispatched.mockResolvedValue(false);

    await dispatchTransactionApproval(baseNotification, "evt-dup");

    expect(sendEmailWithRetry).not.toHaveBeenCalled();
    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("records a delivery failure and rewrites the subscription when push fails", async () => {
    const original = { subscription: makeSub("ep-a"), failureCount: 1, createdAt: 1 };
    const raw = JSON.stringify(original);
    const updated = { ...original, failureCount: 2 };
    redisMock.smembers.mockResolvedValue([raw]);
    sendPushNotification.mockRejectedValue(new Error("410 Gone"));
    recordPushDeliveryFailure.mockReturnValue(updated);

    await dispatchTransactionApproval({ ...baseNotification, email: undefined });

    expect(recordPushDeliveryFailure).toHaveBeenCalledWith(original);
    expect(redisMock.srem).toHaveBeenCalledWith("push:subscriptions:user-1", raw);
    expect(redisMock.sadd).toHaveBeenCalledWith(
      "push:subscriptions:user-1",
      JSON.stringify(updated)
    );
  });

  it("does not throw when email delivery fails; the error is logged", async () => {
    sendEmailWithRetry.mockRejectedValue(new Error("smtp down"));
    await expect(dispatchTransactionApproval(baseNotification)).resolves.toBeUndefined();
  });
});
