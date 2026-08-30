/**
 * Multi-platform push batch sender (Issue #57).
 *
 * Routes each subscription in a PushNotification.subscriptionIds list to its
 * platform's PushProvider (web/android/ios), sends them concurrently, and folds
 * the results into a PushDeliveryResult matching the issue's exact shape.
 *
 * Reuses the existing generic retry/backoff engine (deliveryTracker.ts /
 * retryWorker.ts, Issue #344) rather than re-implementing exponential backoff —
 * every send here is recorded through PushDeliveryTracker, so a failed send is
 * automatically eligible for PushRetryWorker's existing retry pass.
 */
import { createLogger } from "@delegolabs/utils";
import { defaultPushDeliveryTracker, type PushDeliveryTracker } from "../src/deliveryTracker.js";
import type {
  PushDeliveryResult,
  PushDeliveryResultEntry,
  PushNotification,
  PushProvider,
  PushSubscription,
} from "./types.js";

const log = createLogger("notifications:push:batchSender", process.env.LOG_LEVEL ?? "info");

export interface SubscriptionLookup {
  /** Resolves a subscriptionId to its stored PushSubscription, or null if unknown/removed. */
  get(subscriptionId: string): Promise<PushSubscription | null>;
  /** Marks a subscription invalid/removed after a provider reports it as permanently dead. */
  remove(subscriptionId: string): Promise<void>;
}

/** In-memory SubscriptionLookup for tests and local development. */
export class InMemorySubscriptionStore implements SubscriptionLookup {
  private readonly subscriptions = new Map<string, PushSubscription>();

  add(subscription: PushSubscription): void {
    this.subscriptions.set(subscription.id, subscription);
  }

  async get(subscriptionId: string): Promise<PushSubscription | null> {
    return this.subscriptions.get(subscriptionId) ?? null;
  }

  async remove(subscriptionId: string): Promise<void> {
    this.subscriptions.delete(subscriptionId);
  }

  /** Test/inspection helper. */
  has(subscriptionId: string): boolean {
    return this.subscriptions.has(subscriptionId);
  }

  clear(): void {
    this.subscriptions.clear();
  }
}

export interface PushBatchSenderOptions {
  providers: PushProvider[];
  subscriptions: SubscriptionLookup;
  tracker?: PushDeliveryTracker;
}

/**
 * Topic-based subscription filtering (Issue #57): given a topic, resolves which of
 * a candidate list of subscriptions are actually subscribed to it. Kept separate
 * from send() so callers building a subscriptionIds list for a topic broadcast can
 * do so without constructing a PushNotification first.
 */
export function filterSubscriptionsByTopic(
  subscriptions: PushSubscription[],
  topic: string
): PushSubscription[] {
  return subscriptions.filter((s) => s.topics.includes(topic));
}

export class PushBatchSender {
  private readonly providersByPlatform: Map<PushSubscription["platform"], PushProvider>;
  private readonly subscriptions: SubscriptionLookup;
  private readonly tracker: PushDeliveryTracker;

  constructor(options: PushBatchSenderOptions) {
    this.providersByPlatform = new Map(options.providers.map((p) => [p.platform, p]));
    this.subscriptions = options.subscriptions;
    this.tracker = options.tracker ?? defaultPushDeliveryTracker;
  }

  /**
   * Sends `notification` to every subscription in notification.subscriptionIds,
   * concurrently, routing each to its platform's provider. Invalid subscriptions
   * (per the provider's invalid flag) are removed via subscriptions.remove()
   * rather than left to accumulate — this is the Issue #57 "invalid subscriptions
   * auto-cleaned" behavior, happening inline per-batch rather than via a separate
   * sweep (complementing, not replacing, push/index.ts's failure-count/staleness
   * cleanup for Web Push).
   */
  async send(notification: PushNotification): Promise<PushDeliveryResult> {
    const outcomes = await Promise.all(
      notification.subscriptionIds.map((subscriptionId) => this.sendOne(notification, subscriptionId))
    );

    const summary = outcomes.reduce(
      (acc, { entry, invalidated }) => {
        if (entry.success) acc.sent += 1;
        else acc.failed += 1;
        if (invalidated) acc.invalidated += 1;
        return acc;
      },
      { sent: 0, failed: 0, invalidated: 0 }
    );

    return { notificationId: notification.id, results: outcomes.map((o) => o.entry), summary };
  }

  private async sendOne(
    notification: PushNotification,
    subscriptionId: string
  ): Promise<{ entry: PushDeliveryResultEntry; invalidated: boolean }> {
    const timestamp = new Date().toISOString();
    const subscription = await this.subscriptions.get(subscriptionId);

    if (!subscription) {
      return {
        entry: { subscriptionId, success: false, error: "Unknown subscription", timestamp },
        invalidated: false,
      };
    }

    const provider = this.providersByPlatform.get(subscription.platform);
    if (!provider) {
      return {
        entry: {
          subscriptionId,
          success: false,
          error: `No push provider registered for platform "${subscription.platform}"`,
          timestamp,
        },
        invalidated: false,
      };
    }

    const deliveryRecord = this.tracker.recordAttempt(
      subscription.userId,
      subscription.endpoint || subscriptionId,
      { notificationId: notification.id, title: notification.title },
      3,
      `${notification.id}:${subscriptionId}`
    );

    try {
      const outcome = await provider.send(subscription, notification);

      if (outcome.success) {
        this.tracker.recordSuccess(deliveryRecord.id);
        return {
          entry: { subscriptionId, success: true, messageId: outcome.messageId, timestamp },
          invalidated: false,
        };
      }

      this.tracker.recordFailure(deliveryRecord.id, outcome.error ?? "Unknown push provider error");

      let invalidated = false;
      if (outcome.invalid) {
        await this.subscriptions.remove(subscriptionId);
        invalidated = true;
        log.info("Removed invalid push subscription after provider-reported failure", {
          subscriptionId,
          platform: subscription.platform,
        });
      }

      return {
        entry: { subscriptionId, success: false, error: outcome.error, timestamp },
        invalidated,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.tracker.recordFailure(deliveryRecord.id, message);
      return { entry: { subscriptionId, success: false, error: message, timestamp }, invalidated: false };
    }
  }
}
