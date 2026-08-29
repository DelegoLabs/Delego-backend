/**
 * CDN / edge / WAF configuration types (Issue #99).
 *
 * Scoping note: this defines a provider-agnostic config schema and a
 * validator so a CDN configuration can be reviewed and tested before it's
 * applied. It intentionally does NOT provision any actual CDN, WAF, or DNS
 * resources (Terraform modules, CloudFlare/CloudFront/Fastly API calls) —
 * that requires a provider choice and real account credentials that
 * shouldn't be decided unilaterally in this PR. See the PR description for
 * full disclosure.
 */

export type CdnProvider = "cloudflare" | "cloudfront" | "fastly";
export type SslMode = "full" | "flexible" | "strict";
export type WafAction = "block" | "challenge" | "allow" | "log";

export interface CacheRule {
  pattern: string;
  ttl: number;
  browserTtl: number;
  cacheKey: string[];
}

export interface WafRule {
  id: string;
  action: WafAction;
  expression: string;
}

export interface CdnZoneConfig {
  domain: string;
  origin: string;
  sslMode: SslMode;
  cacheRules: CacheRule[];
  wafRules: WafRule[];
}

export interface EdgeFunctionConfig {
  name: string;
  script: string;
  triggers: Array<{ event: string; pattern: string }>;
}

export interface CdnConfig {
  provider: CdnProvider;
  zones: CdnZoneConfig[];
  edgeFunctions: EdgeFunctionConfig[];
}

export interface CacheInvalidationRequest {
  urls: string[];
  tags: string[];
  hosts: string[];
  purgeEverything: boolean;
}

export interface EdgeMetrics {
  zone: string;
  requestsPerSecond: number;
  bandwidthMbps: number;
  cacheHitRatio: number;
  errorRate: number;
  p50LatencyMs: number;
  p99LatencyMs: number;
  blockedRequests: number;
  challengedRequests: number;
}
