/**
 * Multi-platform push notification service types (Issue #57).
 *
 * Matches the issue's specified shapes for PushSubscription, PushNotification,
 * and PushDeliveryResult exactly, so callers building against the issue's
 * documented API surface get precisely that surface.
 */

export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

export interface PushSubscription {
  id: string;
  userId: string;
  platform: "web" | "android" | "ios";
  endpoint: string;
  keys: PushSubscriptionKeys;
  fcmToken?: string;
  apnsToken?: string;
  topics: string[];
  createdAt: string;
  lastUsedAt: string;
}

export interface PushNotificationAction {
  action: string;
  title: string;
}

export interface PushNotification {
  id: string;
  subscriptionIds: string[];
  title: string;
  body: string;
  icon?: string;
  image?: string;
  data: Record<string, unknown>;
  actions?: PushNotificationAction[];
  requireInteraction: boolean;
  ttlSeconds: number;
  collapseKey?: string;
}

export interface PushDeliveryResultEntry {
  subscriptionId: string;
  success: boolean;
  messageId?: string;
  error?: string;
  timestamp: string;
}

export interface PushDeliveryResult {
  notificationId: string;
  results: PushDeliveryResultEntry[];
  summary: {
    sent: number;
    failed: number;
    invalidated: number;
  };
}

/**
 * A single-subscription send outcome from a platform adapter, before it's been
 * folded into a PushDeliveryResultEntry with a timestamp. `invalid` distinguishes
 * "the subscription itself is dead and should be removed" (410/NotRegistered/
 * BadDeviceToken-class errors) from a transient failure worth retrying.
 */
export interface ProviderSendOutcome {
  success: boolean;
  messageId?: string;
  error?: string;
  /** True when the platform reported the subscription/token as permanently invalid. */
  invalid?: boolean;
}

/**
 * Adapter boundary each platform (Web Push / FCM / APNs) implements (Issue #57).
 * PushProvider is intentionally single-subscription — batching, retry, and
 * cross-platform routing live in batchSender.ts, which is what callers use.
 */
export interface PushProvider {
  readonly platform: PushSubscription["platform"];
  send(subscription: PushSubscription, notification: PushNotification): Promise<ProviderSendOutcome>;
}
