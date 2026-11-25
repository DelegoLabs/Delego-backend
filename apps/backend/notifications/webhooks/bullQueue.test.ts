import { beforeEach, describe, expect, it, vi } from "vitest";
import { RETRY_DELAYS_MS, WebhookBullQueue, type WebhookPayload } from "./bullQueue.js";

const bullMocks = vi.hoisted(() => ({
  queueOptions: undefined as unknown,
  queueAdd: vi.fn(async (..._args: unknown[]) => undefined),
  workerOptions: undefined as unknown,
  workerListeners: {} as Record<string, (...args: unknown[]) => void>,
}));

vi.mock("bullmq", () => ({
  Queue: class {
    constructor(_name: string, options: unknown) {
      bullMocks.queueOptions = options;
    }

    add(...args: unknown[]) {
      return bullMocks.queueAdd(...args);
    }

    async getActiveCount() {
      return 0;
    }

    async getWaitingCount() {
      return 0;
    }

    async getCompletedCount() {
      return 0;
    }

    async getFailedCount() {
      return 0;
    }

    async getDelayedCount() {
      return 0;
    }

    async drain() {}
  },
  Worker: class {
    constructor(_name: string, _processor: unknown, options: unknown) {
      bullMocks.workerOptions = options;
    }

    on(event: string, listener: (...args: unknown[]) => void) {
      bullMocks.workerListeners[event] = listener;
      return this;
    }

    async close() {}
  },
  QueueEvents: class {
    async close() {}
  },
}));

const payload: WebhookPayload = {
  id: "event-1",
  event: "order.created",
  timestamp: "2026-11-25T00:00:00.000Z",
  data: { orderId: "order-1" },
};

function makeQueue(): WebhookBullQueue {
  return new WebhookBullQueue({ host: "localhost", port: 6379 });
}

beforeEach(() => {
  vi.clearAllMocks();
  bullMocks.queueOptions = undefined;
  bullMocks.workerOptions = undefined;
  for (const event of Object.keys(bullMocks.workerListeners)) {
    delete bullMocks.workerListeners[event];
  }
});

describe("WebhookBullQueue", () => {
  it("uses a supported custom backoff configuration and the configured retry delays", async () => {
    const queue = makeQueue();
    queue.start();

    const queueOptions = bullMocks.queueOptions as {
      defaultJobOptions: { attempts: number; backoff: { type: string; delay?: number } };
    };
    expect(queueOptions.defaultJobOptions).toEqual({
      attempts: 5,
      backoff: { type: "custom" },
      removeOnComplete: true,
      removeOnFail: false,
    });

    const workerOptions = bullMocks.workerOptions as {
      settings?: { backoffStrategy?: (attemptsMade: number, type?: string) => number };
    };
    const backoffStrategy = workerOptions.settings?.backoffStrategy;
    expect(backoffStrategy).toBeTypeOf("function");
    expect(backoffStrategy?.(1, "custom")).toBe(RETRY_DELAYS_MS[0]);
    expect(backoffStrategy?.(2, "custom")).toBe(RETRY_DELAYS_MS[1]);
    expect(backoffStrategy?.(5, "custom")).toBe(RETRY_DELAYS_MS[4]);
    expect(backoffStrategy?.(10, "custom")).toBe(RETRY_DELAYS_MS[4]);
    expect(backoffStrategy?.(1, "unsupported")).toBe(-1);

    await queue.stop();
  });

  it("enqueues retries with a bounded delay based on the attempt", async () => {
    const queue = makeQueue();

    await queue.enqueueWithBackoff("webhook-1", payload, 0);
    await queue.enqueueWithBackoff("webhook-1", payload, 2);
    await queue.enqueueWithBackoff("webhook-1", payload, 10);

    expect(bullMocks.queueAdd).toHaveBeenNthCalledWith(
      1,
      "deliver-webhook",
      { webhookId: "webhook-1", payload, attempt: 1 },
      { delay: RETRY_DELAYS_MS[0] },
    );
    expect(bullMocks.queueAdd).toHaveBeenNthCalledWith(
      2,
      "deliver-webhook",
      { webhookId: "webhook-1", payload, attempt: 1 },
      { delay: RETRY_DELAYS_MS[1] },
    );
    expect(bullMocks.queueAdd).toHaveBeenNthCalledWith(
      3,
      "deliver-webhook",
      { webhookId: "webhook-1", payload, attempt: 1 },
      { delay: RETRY_DELAYS_MS[4] },
    );
  });

  it("handles a failed event without a job reference", async () => {
    const queue = makeQueue();
    queue.start();
    const failedListener = bullMocks.workerListeners.failed;

    expect(() => failedListener(undefined, new Error("processing failed"))).not.toThrow();

    await queue.stop();
  });
});
