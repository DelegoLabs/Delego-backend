/**
 * SSRF prevention validator for merchant webhook URLs (Issue #614).
 *
 * Merchants can configure outbound webhook callback URLs. Without this
 * guard, a malicious merchant could point a webhook at an internal address
 * (`http://169.254.169.254`, `http://localhost:5432`) and use Delego's own
 * servers to probe/attack internal network or cloud-metadata endpoints.
 *
 * `validateSsrfUrl` resolves DNS and verifies the resolved IP does not fall
 * into RFC 1918 (private), RFC 3927 (link-local), loopback, or cloud
 * metadata ranges. `dispatchWithSsrfProtection` then pins that exact IP for
 * the actual HTTP request and re-validates immediately before connecting —
 * closing the DNS-rebinding window between validation and dispatch, where a
 * hostname that resolved safely moments ago could have been repointed at a
 * private address by the time the request is actually sent.
 */

import { lookup as dnsLookupCallback } from "node:dns";
import { request as httpsRequest } from "node:https";
import { promisify } from "node:util";
import type { LookupAddress } from "node:dns";

const defaultDnsLookup = promisify(dnsLookupCallback) as unknown as (
  hostname: string,
) => Promise<LookupAddress>;

export type SsrfRejectionReason =
  | "private_ip"
  | "loopback"
  | "link_local"
  | "cloud_metadata"
  | "dns_rebinding"
  | "unsupported_protocol"
  | "dns_resolution_failed";

export interface SsrfValidationResult {
  isValid: boolean;
  resolvedIp?: string;
  rejectionReason?: SsrfRejectionReason;
}

/** Cloud metadata endpoints shared across AWS/GCP/Azure/DigitalOcean (IPv4) and AWS IPv6. */
const CLOUD_METADATA_IPV4 = new Set(["169.254.169.254", "169.254.170.2"]);
const CLOUD_METADATA_IPV6_PATTERN = /^fd00:ec2::254$/i;

function isLoopbackIPv4(ip: string): boolean {
  return ip === "127.0.0.1" || ip.startsWith("127.");
}

function isLinkLocalIPv4(ip: string): boolean {
  return ip.startsWith("169.254.");
}

/** RFC 1918 private ranges and other reserved/special-use IPv4 ranges. */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    // Not a well-formed IPv4 literal — fail closed.
    return true;
  }
  const [a, b] = parts;

  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 — CGNAT
  if (a === 198 && b === 18) return true; // 198.18.0.0/15 — benchmarking
  if (a >= 224) return true; // multicast + reserved

  return false;
}

function isLoopbackIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return normalized === "::1";
}

function isLinkLocalIPv6(ip: string): boolean {
  return /^fe[89ab][0-9a-f]:/i.test(ip);
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::") return true; // unspecified
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // fc00::/7 — unique local

  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);

  return false;
}

/** Classifies a resolved IP into the first matching rejection reason, or undefined if public. */
function classifyIp(ip: string, family: 4 | 6): SsrfRejectionReason | undefined {
  if (family === 4) {
    if (CLOUD_METADATA_IPV4.has(ip)) return "cloud_metadata";
    if (isLoopbackIPv4(ip)) return "loopback";
    if (isLinkLocalIPv4(ip)) return "link_local";
    if (isPrivateIPv4(ip)) return "private_ip";
    return undefined;
  }

  if (CLOUD_METADATA_IPV6_PATTERN.test(ip)) return "cloud_metadata";
  if (isLoopbackIPv6(ip)) return "loopback";
  if (isLinkLocalIPv6(ip)) return "link_local";
  if (isPrivateIPv6(ip)) return "private_ip";
  return undefined;
}

export function isPrivateOrReservedIp(ip: string, family: 4 | 6): boolean {
  return classifyIp(ip, family) !== undefined;
}

export interface SsrfValidationOptions {
  /** Injectable for tests; defaults to `dns.lookup`. */
  resolveHostname?: (hostname: string) => Promise<LookupAddress>;
  /** Require HTTPS. Defaults to true. */
  requireHttps?: boolean;
}

/**
 * Resolves `rawUrl`'s hostname and checks the resolved IP against private,
 * loopback, link-local, and cloud-metadata ranges. Must be called
 * immediately before each delivery attempt — a hostname that resolves
 * safely now can be repointed at a private address later (DNS rebinding).
 */
export async function validateSsrfUrl(
  rawUrl: string,
  options: SsrfValidationOptions = {},
): Promise<SsrfValidationResult> {
  const resolveHostname = options.resolveHostname ?? defaultDnsLookup;
  const requireHttps = options.requireHttps ?? true;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { isValid: false, rejectionReason: "unsupported_protocol" };
  }

  if (requireHttps && parsed.protocol !== "https:") {
    return { isValid: false, rejectionReason: "unsupported_protocol" };
  }
  if (!requireHttps && parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { isValid: false, rejectionReason: "unsupported_protocol" };
  }

  let resolved: LookupAddress;
  try {
    resolved = await resolveHostname(parsed.hostname);
  } catch {
    return { isValid: false, rejectionReason: "dns_resolution_failed" };
  }

  const { address, family } = resolved;
  const rejectionReason = classifyIp(address, family as 4 | 6);
  if (rejectionReason) {
    return { isValid: false, resolvedIp: address, rejectionReason };
  }

  return { isValid: true, resolvedIp: address };
}

/**
 * Builds a `lookup` function for Node's `http(s).request` options that
 * always resolves to `pinnedIp`, ignoring whatever DNS answers at connect
 * time. Combined with a fresh re-validation immediately before the request
 * (see `dispatchWithSsrfProtection`), this defeats DNS rebinding: the
 * connection is forced onto the exact address that was just validated,
 * rather than re-resolving the hostname and potentially getting a
 * different, attacker-controlled answer.
 */
export function createPinnedLookup(pinnedIp: string, family: 4 | 6) {
  return (
    _hostname: string,
    _options: unknown,
    callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ): void => {
    callback(null, pinnedIp, family);
  };
}

export interface SsrfSafeDispatchResult {
  status: number;
  statusText: string;
  body: string;
}

/**
 * POSTs `body` to the validated, resolved IP behind `rawUrl`, pinning the
 * TCP connection to that address. Immediately before dispatch, the hostname
 * is resolved a second time and compared to the IP from the initial
 * validation; a mismatch means the DNS answer changed between validation
 * and send (DNS rebinding) and the request is refused rather than sent to
 * the new, unvalidated address.
 */
export async function dispatchWithSsrfProtection(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
  options: SsrfValidationOptions & { timeoutMs?: number } = {},
): Promise<{ result: SsrfValidationResult; response?: SsrfSafeDispatchResult }> {
  const timeoutMs = options.timeoutMs ?? 10_000;

  const initial = await validateSsrfUrl(rawUrl, options);
  if (!initial.isValid || !initial.resolvedIp) {
    return { result: initial };
  }

  // Re-resolve right before connecting; a changed answer is a rebinding attempt.
  const resolveHostname = options.resolveHostname ?? defaultDnsLookup;
  const parsed = new URL(rawUrl);
  let revalidated: LookupAddress;
  try {
    revalidated = await resolveHostname(parsed.hostname);
  } catch {
    return { result: { isValid: false, rejectionReason: "dns_resolution_failed" } };
  }

  if (revalidated.address !== initial.resolvedIp) {
    return {
      result: { isValid: false, resolvedIp: revalidated.address, rejectionReason: "dns_rebinding" },
    };
  }

  const family = initial.resolvedIp.includes(":") ? 6 : 4;
  const lookup = createPinnedLookup(initial.resolvedIp, family);
  const payload = Buffer.from(body, "utf8");

  const response = await new Promise<SsrfSafeDispatchResult>((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: parsed.hostname,
        servername: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: "POST",
        headers: { ...headers, "Content-Length": String(payload.byteLength) },
        lookup: lookup as unknown as never,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );

    req.on("timeout", () => req.destroy(new Error(`Webhook request timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });

  return { result: initial, response };
}
