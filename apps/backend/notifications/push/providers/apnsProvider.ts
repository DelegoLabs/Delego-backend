/**
 * Apple Push Notification service (APNs) provider adapter (Issue #57), targeting iOS.
 *
 * APNs requires HTTP/2 — Node's built-in `fetch` (undici) does not speak HTTP/2, so
 * this uses Node's built-in `node:http2` module directly rather than pulling in a
 * third-party APNs SDK (e.g. node-apn) for what is, at the protocol level, a single
 * POST per notification with a provider authentication token header. No new
 * dependency needed beyond `jsonwebtoken`, already used elsewhere in this service for
 * gateway-style JWTs.
 *
 * Auth: provider authentication tokens (ES256 JWT, signed with an Apple-issued .p8
 * key, docs: https://developer.apple.com/documentation/usernotifications/
 * establishing-a-token-based-connection-to-apns) rather than certificate-based auth —
 * tokens don't expire per-device and are the currently recommended approach. Cached
 * and reused across sends until near expiry, matching Apple's guidance not to
 * generate a new token for every request.
 *
 * No real APNs credentials or device tokens exist in this environment — see
 * apnsProvider.test.ts for how the HTTP/2 session is mocked. Nothing here has been
 * exercised against Apple's real sandbox/production APNs endpoints; see the PR
 * description's built-vs-documented breakdown.
 */
import http2 from "node:http2";
import jwt from "jsonwebtoken";
import { createLogger } from "@delegolabs/utils";
import type { PushNotification, PushProvider, PushSubscription, ProviderSendOutcome } from "../types.js";

const log = createLogger("notifications:push:apns", process.env.LOG_LEVEL ?? "info");

const TOKEN_MAX_AGE_MS = 55 * 60_000; // Apple tokens are valid up to 60 min; refresh a bit early.

export interface ApnsConfig {
  /** Apple Developer Team ID. */
  teamId: string;
  /** APNs Auth Key ID (from the .p8 key's filename, e.g. "AuthKey_XXXXXXXXXX.p8"). */
  keyId: string;
  /** PEM-encoded ES256 private key contents (the .p8 file's contents). */
  privateKey: string;
  /** Your app's bundle id, sent as the `apns-topic` header. */
  bundleId: string;
  /** "production" | "sandbox" — selects the APNs host. Defaults to "production". */
  environment?: "production" | "sandbox";
}

function loadConfigFromEnv(): ApnsConfig | null {
  const teamId = process.env.APNS_TEAM_ID;
  const keyId = process.env.APNS_KEY_ID;
  const privateKey = process.env.APNS_PRIVATE_KEY;
  const bundleId = process.env.APNS_BUNDLE_ID;
  if (!teamId || !keyId || !privateKey || !bundleId) return null;
  return {
    teamId,
    keyId,
    // Support the private key being stored with literal "\n" sequences in an env var.
    privateKey: privateKey.includes("\\n") ? privateKey.replace(/\\n/g, "\n") : privateKey,
    bundleId,
    environment: process.env.APNS_ENVIRONMENT === "sandbox" ? "sandbox" : "production",
  };
}

interface CachedProviderToken {
  token: string;
  issuedAt: number;
}

/** Generates and caches the ES256 provider authentication token APNs requires per connection. */
export class ApnsTokenProvider {
  private cached: CachedProviderToken | null = null;

  constructor(private readonly config: ApnsConfig) {}

  getToken(now: number = Date.now()): string {
    if (this.cached && now - this.cached.issuedAt < TOKEN_MAX_AGE_MS) {
      return this.cached.token;
    }

    const token = jwt.sign({}, this.config.privateKey, {
      algorithm: "ES256",
      issuer: this.config.teamId,
      keyid: this.config.keyId,
      // APNs wants `iat` in seconds (jwt.sign() default) and no `exp` claim.
    });

    this.cached = { token, issuedAt: now };
    return token;
  }
}

/** Minimal HTTP/2 client wrapper so the send path is unit-testable without a real socket. */
export interface Http2Client {
  request(
    host: string,
    headers: http2.OutgoingHttpHeaders,
    body: string
  ): Promise<{ status: number; body: string }>;
}

class NodeHttp2Client implements Http2Client {
  async request(
    host: string,
    headers: http2.OutgoingHttpHeaders,
    body: string
  ): Promise<{ status: number; body: string }> {
    const session = http2.connect(host);
    try {
      return await new Promise((resolve, reject) => {
        const req = session.request(headers);
        let responseBody = "";
        let status = 0;

        req.on("response", (responseHeaders) => {
          status = Number(responseHeaders[":status"] ?? 0);
        });
        req.on("data", (chunk) => {
          responseBody += chunk;
        });
        req.on("end", () => resolve({ status, body: responseBody }));
        req.on("error", reject);

        req.write(body);
        req.end();
      });
    } finally {
      session.close();
    }
  }
}

/** APNs error reasons that mean the token is permanently invalid (docs: BadDeviceToken, Unregistered). */
const INVALID_TOKEN_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

export class ApnsProvider implements PushProvider {
  readonly platform = "ios" as const;

  private readonly tokenProvider: ApnsTokenProvider | null;
  private readonly config: ApnsConfig | null;
  private readonly http2Client: Http2Client;

  constructor(config: ApnsConfig | null = loadConfigFromEnv(), http2Client: Http2Client = new NodeHttp2Client()) {
    this.config = config;
    this.tokenProvider = config ? new ApnsTokenProvider(config) : null;
    this.http2Client = http2Client;
  }

  async send(subscription: PushSubscription, notification: PushNotification): Promise<ProviderSendOutcome> {
    if (!this.tokenProvider || !this.config) {
      return { success: false, error: "APNs credentials are not configured" };
    }
    if (!subscription.apnsToken) {
      return { success: false, error: "Subscription has no apnsToken", invalid: true };
    }

    const host =
      this.config.environment === "sandbox"
        ? "https://api.sandbox.push.apple.com:443"
        : "https://api.push.apple.com:443";

    const payload = JSON.stringify({
      aps: {
        alert: { title: notification.title, body: notification.body },
        "mutable-content": notification.image ? 1 : 0,
        sound: "default",
      },
      ...notification.data,
    });

    const headers: http2.OutgoingHttpHeaders = {
      ":method": "POST",
      ":path": `/3/device/${subscription.apnsToken}`,
      authorization: `bearer ${this.tokenProvider.getToken()}`,
      "apns-topic": this.config.bundleId,
      "apns-expiration": String(Math.floor(Date.now() / 1000) + notification.ttlSeconds),
      "apns-priority": notification.requireInteraction ? "10" : "5",
      "content-type": "application/json",
      ...(notification.collapseKey ? { "apns-collapse-id": notification.collapseKey } : {}),
    };

    try {
      const response = await this.http2Client.request(host, headers, payload);

      if (response.status !== 200) {
        const body = (JSON.parse(response.body || "{}") as { reason?: string }) ?? {};
        log.warn("APNs send failed", { status: response.status, reason: body.reason });
        return {
          success: false,
          error: body.reason ?? `APNs send failed (${response.status})`,
          invalid: body.reason ? INVALID_TOKEN_REASONS.has(body.reason) : false,
        };
      }

      // APNs returns 200 with an empty body and the notification id in the
      // apns-id response header — the minimal Http2Client interface above only
      // surfaces status + body, which is sufficient to distinguish success/
      // failure; a fuller header-capturing client can be swapped in without
      // changing this call site if the message id is needed later.
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
