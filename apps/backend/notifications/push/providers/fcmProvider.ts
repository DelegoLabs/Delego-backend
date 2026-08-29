/**
 * Firebase Cloud Messaging (FCM) provider adapter (Issue #57), targeting Android.
 *
 * Uses FCM's HTTP v1 API (https://fcm.googleapis.com/v1/projects/{project}/messages:send)
 * directly via fetch rather than the firebase-admin SDK — this service already talks to
 * every other external API (Stellar Horizon, SendGrid, downstream services) via fetch/
 * REST, and HTTP v1 needs nothing beyond an OAuth2 access token, which is straightforward
 * to obtain from a service account's private key without pulling in firebase-admin's
 * full dependency tree for a single send call.
 *
 * Auth: exchanges a self-signed JWT (service account credentials) for a short-lived
 * OAuth2 access token via Google's token endpoint (RFC 7523 JWT Bearer flow), then
 * caches that token until shortly before it expires.
 *
 * No real FCM project credentials exist in this environment — see fcmProvider.test.ts
 * for how the network calls are mocked. Nothing here has been exercised against a real
 * FCM project; see the PR description's built-vs-documented breakdown.
 */
import jwt from "jsonwebtoken";
import { createLogger } from "@delegolabs/utils";
import type { PushNotification, PushProvider, PushSubscription, ProviderSendOutcome } from "../types.js";

const log = createLogger("notifications:push:fcm", process.env.LOG_LEVEL ?? "info");

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_REFRESH_SKEW_MS = 60_000;

export interface FcmServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

function loadServiceAccountFromEnv(): FcmServiceAccount | null {
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FcmServiceAccount>;
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) return null;
    return parsed as FcmServiceAccount;
  } catch {
    return null;
  }
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * Exchanges FCM service-account credentials for an OAuth2 access token via the
 * standard JWT Bearer grant, caching it until TOKEN_REFRESH_SKEW_MS before expiry.
 * Exported for direct unit testing of the auth flow independent of a send() call.
 */
export class FcmAccessTokenProvider {
  private cached: CachedToken | null = null;

  constructor(
    private readonly serviceAccount: FcmServiceAccount,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async getAccessToken(now: number = Date.now()): Promise<string> {
    if (this.cached && this.cached.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
      return this.cached.accessToken;
    }

    const assertion = jwt.sign(
      {
        scope: FCM_SCOPE,
        aud: GOOGLE_TOKEN_URL,
      },
      this.serviceAccount.private_key,
      {
        algorithm: "RS256",
        issuer: this.serviceAccount.client_email,
        subject: this.serviceAccount.client_email,
        expiresIn: "1h",
      }
    );

    const response = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`FCM token exchange failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.cached = {
      accessToken: data.access_token,
      expiresAt: now + data.expires_in * 1000,
    };
    return this.cached.accessToken;
  }
}

/** Error codes FCM returns for a permanently invalid/unregistered token. */
const INVALID_TOKEN_ERROR_CODES = new Set([
  "UNREGISTERED",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
]);

export class FcmProvider implements PushProvider {
  readonly platform = "android" as const;

  private readonly tokenProvider: FcmAccessTokenProvider | null;
  private readonly projectId: string | null;

  constructor(
    serviceAccount: FcmServiceAccount | null = loadServiceAccountFromEnv(),
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.tokenProvider = serviceAccount ? new FcmAccessTokenProvider(serviceAccount, fetchImpl) : null;
    this.projectId = serviceAccount?.project_id ?? null;
  }

  async send(subscription: PushSubscription, notification: PushNotification): Promise<ProviderSendOutcome> {
    if (!this.tokenProvider || !this.projectId) {
      return { success: false, error: "FCM service account is not configured" };
    }
    if (!subscription.fcmToken) {
      return { success: false, error: "Subscription has no fcmToken", invalid: true };
    }

    let accessToken: string;
    try {
      accessToken = await this.tokenProvider.getAccessToken();
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    const message = {
      message: {
        token: subscription.fcmToken,
        notification: { title: notification.title, body: notification.body, image: notification.image },
        data: Object.fromEntries(
          Object.entries(notification.data).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])
        ),
        android: {
          ttl: `${notification.ttlSeconds}s`,
          ...(notification.collapseKey ? { collapse_key: notification.collapseKey } : {}),
          notification: {
            icon: notification.icon,
            ...(notification.requireInteraction ? { sticky: true } : {}),
          },
        },
      },
    };

    try {
      const response = await this.fetchImpl(
        `https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(message),
        }
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { status?: string; message?: string } }
          | null;
        const status = body?.error?.status;
        const errorMessage = body?.error?.message ?? `FCM send failed (${response.status})`;
        log.warn("FCM send failed", { status: response.status, fcmStatus: status, error: errorMessage });
        return {
          success: false,
          error: errorMessage,
          invalid: status ? INVALID_TOKEN_ERROR_CODES.has(status) : false,
        };
      }

      const data = (await response.json()) as { name: string };
      return { success: true, messageId: data.name };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
