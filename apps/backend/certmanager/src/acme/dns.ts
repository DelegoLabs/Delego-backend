import type { DnsProviderConfig } from "@delegolabs/types";
import type { AcmeChallenge } from "./types.js";

export interface DnsProvider {
  readonly type: string;
  present(challenge: AcmeChallenge): Promise<void>;
  cleanup(challenge: AcmeChallenge): Promise<void>;
}

/**
 * In-memory DNS provider used for local development and tests. It records the
 * TXT records that would have been created so challenge behaviour can be
 * asserted without touching a real DNS provider.
 */
export class MemoryDnsProvider implements DnsProvider {
  public readonly type = "memory";
  public readonly records = new Map<string, string>();

  async present(challenge: AcmeChallenge): Promise<void> {
    this.records.set(`_acme-challenge.${challenge.targetDomain}`, challenge.value);
  }

  async cleanup(challenge: AcmeChallenge): Promise<void> {
    this.records.delete(`_acme-challenge.${challenge.targetDomain}`);
  }
}

/**
 * Cloudflare DNS provider. Uses the Cloudflare v4 API to create/remove the
 * `_acme-challenge` TXT record required for dns-01.
 */
export class CloudflareDnsProvider implements DnsProvider {
  public readonly type = "cloudflare";
  private readonly apiToken: string;
  private readonly zoneId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly base = "https://api.cloudflare.com/client/v4";

  constructor(credentials: Record<string, string>, fetchImpl: typeof fetch = fetch) {
    const apiToken = credentials.apiToken ?? credentials.api_token;
    const zoneId = credentials.zoneId ?? credentials.zone_id;
    if (!apiToken || !zoneId) {
      throw new Error("cloudflare DNS provider requires apiToken and zoneId credentials");
    }
    this.apiToken = apiToken;
    this.zoneId = zoneId;
    this.fetchImpl = fetchImpl;
  }

  async present(challenge: AcmeChallenge): Promise<void> {
    const name = `_acme-challenge.${challenge.targetDomain}`;
    const res = await this.fetchImpl(`${this.base}/zones/${this.zoneId}/dns_records`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "TXT", name, content: challenge.value, ttl: 60 }),
    });
    if (!res.ok) {
      throw new Error(`cloudflare present failed: ${res.status} ${await res.text()}`);
    }
  }

  async cleanup(challenge: AcmeChallenge): Promise<void> {
    const name = `_acme-challenge.${challenge.targetDomain}`;
    const list = await this.fetchImpl(
      `${this.base}/zones/${this.zoneId}/dns_records?type=TXT&name=${encodeURIComponent(name)}`,
      { headers: { Authorization: `Bearer ${this.apiToken}` } },
    );
    if (!list.ok) return;
    const body = (await list.json()) as { result?: Array<{ id: string }> };
    for (const record of body.result ?? []) {
      await this.fetchImpl(
        `${this.base}/zones/${this.zoneId}/dns_records/${record.id}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${this.apiToken}` } },
      );
    }
  }
}

/**
 * Placeholder providers for Route53 / Azure / Google. These require cloud
 * SDKs (AWS SigV4, Azure OAuth, GCP OAuth) which are wired through the
 * `DNS_PROVIDER_WEBHOOK_URL` adapter when present, otherwise they throw a
 * clear error so misconfiguration fails fast rather than silently.
 */
abstract class WebhookDnsProvider implements DnsProvider {
  abstract readonly type: string;
  constructor(
    protected readonly credentials: Record<string, string>,
    protected readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private get webhookUrl(): string {
    const url = this.credentials.webhookUrl ?? process.env.DNS_PROVIDER_WEBHOOK_URL;
    if (!url) throw new Error(`${this.type} DNS provider requires DNS_PROVIDER_WEBHOOK_URL`);
    return url;
  }

  async present(challenge: AcmeChallenge): Promise<void> {
    await this.call("present", challenge);
  }

  async cleanup(challenge: AcmeChallenge): Promise<void> {
    await this.call("cleanup", challenge);
  }

  private async call(action: "present" | "cleanup", challenge: AcmeChallenge): Promise<void> {
    const res = await this.fetchImpl(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: this.type, action, challenge }),
    });
    if (!res.ok) {
      throw new Error(`${this.type} ${action} failed: ${res.status}`);
    }
  }
}

export class Route53DnsProvider extends WebhookDnsProvider {
  readonly type = "route53";
}
export class AzureDnsProvider extends WebhookDnsProvider {
  readonly type = "azure";
}
export class GoogleDnsProvider extends WebhookDnsProvider {
  readonly type = "google";
}

export function createDnsProvider(config: DnsProviderConfig): DnsProvider {
  switch (config.type) {
    case "cloudflare":
      return new CloudflareDnsProvider(config.credentials);
    case "route53":
      return new Route53DnsProvider(config.credentials);
    case "azure":
      return new AzureDnsProvider(config.credentials);
    case "google":
      return new GoogleDnsProvider(config.credentials);
    default:
      throw new Error(`unsupported DNS provider: ${config.type}`);
  }
}
