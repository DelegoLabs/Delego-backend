/**
 * Web Push (VAPID) provider adapter (Issue #57).
 *
 * Wraps the existing web-push integration (push/index.ts, Issue #137) behind the
 * PushProvider interface so batchSender.ts can route to it alongside FCM/APNs.
 */
import webpush from "web-push";
import { getVapidPublicKey } from "../index.js";
import type { PushNotification, PushProvider, PushSubscription, ProviderSendOutcome } from "../types.js";

/**
 * web-push error shape (WebPushError) exposes `statusCode`; 404/410 mean the
 * subscription is gone (unsubscribed or expired) and should be removed rather
 * than retried — same distinction push/index.ts's cleanup logic already makes
 * via failureCount, just surfaced per-send here instead of via a separate scan.
 */
function isInvalidSubscriptionError(err: unknown): boolean {
  const statusCode = (err as { statusCode?: number } | undefined)?.statusCode;
  return statusCode === 404 || statusCode === 410;
}

export class WebPushProvider implements PushProvider {
  readonly platform = "web" as const;

  async send(subscription: PushSubscription, notification: PushNotification): Promise<ProviderSendOutcome> {
    // getVapidPublicKey() forces evaluation of push/index.ts's module-level
    // webpush.setVapidDetails() call (import side effect) so VAPID is configured
    // even if this provider is imported/used before push/index.ts otherwise would be.
    if (!getVapidPublicKey()) {
      return { success: false, error: "VAPID keys are not configured" };
    }
    if (!subscription.keys?.p256dh || !subscription.keys?.auth) {
      return { success: false, error: "Missing p256dh/auth keys for web push subscription", invalid: true };
    }

    const payload = JSON.stringify({
      title: notification.title,
      body: notification.body,
      icon: notification.icon,
      image: notification.image,
      data: notification.data,
      actions: notification.actions,
      requireInteraction: notification.requireInteraction,
    });

    try {
      const result = await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: subscription.keys },
        payload,
        {
          TTL: notification.ttlSeconds,
          ...(notification.collapseKey ? { topic: notification.collapseKey } : {}),
        }
      );
      // web-push's sendNotification resolves with the raw push service response;
      // there is no provider-assigned message id for Web Push the way FCM/APNs
      // return one, so the HTTP status code is the closest equivalent evidence
      // of what happened, and doubles as this send's traceable identifier.
      return { success: true, messageId: `web-push-${result.statusCode}` };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        invalid: isInvalidSubscriptionError(err),
      };
    }
  }
}
