import { isIP } from "node:net";
import * as tls from "node:tls";
import { createSocket } from "node:dgram";
import type { AuditLogEntry } from "./types.js";

export type AuditLogTransport = (entry: AuditLogEntry) => void | Promise<void>;

export interface CefSyslogOptions {
  host: string;
  port: number;
  timeoutMs?: number;
  ca?: string | Buffer;
}

/**
 * Generic security/compliance event, formatted as CEF and streamed to an
 * external SIEM (Issue #619). Unlike {@link AuditLogEntry} — which is a
 * committed row of the tamper-evident audit hash chain — a `CefEvent` is
 * raised directly by application code at the moment a security-relevant
 * action happens (an auth failure, a key rotation, a permission change),
 * so it carries its own vendor/product/severity framing rather than
 * inheriting it from a DB row.
 */
export interface CefEvent {
  deviceVendor: string;
  deviceProduct: string;
  deviceVersion: string;
  deviceEventClassId: string;
  name: string;
  severity: "low" | "medium" | "high" | "critical";
  extension: {
    srcIp?: string;
    suser?: string;
    act?: string;
    msg?: string;
    customFields?: Record<string, string>;
  };
}

/** UDP syslog destination for {@link createSecurityEventSyslogUdpTransport}. */
export interface CefSyslogUdpOptions {
  host: string;
  port: number;
  timeoutMs?: number;
}

export type SecurityEventTransport = (event: CefEvent) => void | Promise<void>;

/**
 * CEF defines severity as an integer 0-10 (ArcSight convention: 0-3 Low,
 * 4-6 Medium, 7-8 High, 9-10 Very-High). `CefEvent.severity` is the coarser
 * caller-facing enum; this maps each level to a representative CEF integer.
 */
const CEF_SEVERITY_LEVELS: Readonly<Record<CefEvent["severity"], number>> = {
  low: 3,
  medium: 6,
  high: 8,
  critical: 10,
};

function escapeHeader(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}


function escapeExtension(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/=/g, "\\=")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}


function extension(key: string, value: string | number | null): string | null {
  return value === null || value === "" ? null : `${key}=${escapeExtension(String(value))}`;
}

export function formatCef(entry: AuditLogEntry): string {
  const header = [
    "CEF:0",
    "DelegoLabs",
    "Delego",
    "1.0",
    entry.operation,
    `${entry.operation} audit event`,
    "5",
  ].map((part, index) => index === 0 ? part : escapeHeader(part));

  const fields = [
    extension("eventId", entry.id),
    extension("sequenceNum", entry.sequenceNum),
    extension("suser", entry.userId),
    extension("src", entry.ipAddress),
    extension("cs1Label", "tableName"),
    extension("cs1", entry.tableName),
    extension("cs2Label", "recordId"),
    extension("cs2", entry.recordId),
    extension("cs3Label", "changedFields"),
    extension("cs3", entry.changedFields.join(",")),
    extension("rt", entry.occurredAt.getTime()),
    extension("externalId", entry.transactionId),
    extension("deviceCustomString1Label", "entryHash"),
    extension("deviceCustomString1", entry.entryHash),
    extension("deviceCustomString2Label", "previousEntryHash"),
    extension("deviceCustomString2", entry.prevHash),
  ].filter((field): field is string => field !== null);

  return `${header.join("|")}|${fields.join(" ")}`;
}

export function createCefSyslogTransport(
  options: CefSyslogOptions,
  connect: typeof tls.connect = tls.connect
): AuditLogTransport {
  const timeoutMs = options.timeoutMs ?? 5_000;

  return (entry) => new Promise<void>((resolve, reject) => {
    const socket = connect({
      host: options.host,
      port: options.port,
      rejectUnauthorized: true,
      servername: isIP(options.host) ? undefined : options.host,
      checkServerIdentity: (_servername, certificate) => tls.checkServerIdentity(options.host, certificate),
      ...(options.ca ? { ca: options.ca } : {}),
    });
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(timeoutMs, () => fail(new Error("CEF Syslog TLS connection timed out")));
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      socket.end(`${formatCef(entry)}\n`, () => {
        if (settled) return;
        settled = true;
        resolve();
      });
    });
  });
}

let auditLogTransport: AuditLogTransport | undefined;

export function configureAuditLogTransport(transport?: AuditLogTransport): void {
  auditLogTransport = transport;
}

export function dispatchAuditLogEntry(entry: AuditLogEntry): void {
  if (!auditLogTransport) return;
  try {
    void Promise.resolve(auditLogTransport(entry)).catch(() => undefined);
  } catch {
    // An external SIEM outage must not roll back or hide a committed audit entry.
  }
}

/**
 * Format a {@link CefEvent} as a CEF:0 log line, escaping header and
 * extension fields per the ArcSight CEF specification (pipes/backslashes in
 * header fields, equals signs/backslashes in extension values; CRLF escaped
 * in both). `customFields` are appended as additional extension key=value
 * pairs after the well-known `src`/`suser`/`act`/`msg` fields.
 */
export function formatCefEvent(event: CefEvent): string {
  const header = [
    "CEF:0",
    event.deviceVendor,
    event.deviceProduct,
    event.deviceVersion,
    event.deviceEventClassId,
    event.name,
    String(CEF_SEVERITY_LEVELS[event.severity]),
  ].map((part, index) => (index === 0 ? part : escapeHeader(part)));

  const fields = [
    extension("src", event.extension.srcIp ?? null),
    event.extension.suser ? `suser=${escapeHeader(event.extension.suser)}` : null,
    extension("act", event.extension.act ?? null),
    extension("msg", event.extension.msg ?? null),
    ...Object.entries(event.extension.customFields ?? {}).map(([key, value]) => extension(key, value)),
  ].filter((field): field is string => field !== null);

  return `${header.join("|")}|${fields.join(" ")}`;
}

/**
 * Send a pre-formatted CEF message over a TLS syslog connection. Shared by
 * {@link createCefSyslogTransport} (audit-chain entries) and
 * {@link createSecurityEventSyslogTlsTransport} (ad-hoc security events) so
 * both transports open/verify/tear down the TLS socket identically.
 */
function sendCefOverTls(
  message: string,
  options: CefSyslogOptions,
  connect: typeof tls.connect
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;

  return new Promise<void>((resolve, reject) => {
    const socket = connect({
      host: options.host,
      port: options.port,
      rejectUnauthorized: true,
      servername: isIP(options.host) ? undefined : options.host,
      checkServerIdentity: (_servername, certificate) => tls.checkServerIdentity(options.host, certificate),
      ...(options.ca ? { ca: options.ca } : {}),
    });
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(timeoutMs, () => fail(new Error("CEF Syslog TLS connection timed out")));
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      socket.end(`${message}\n`, () => {
        if (settled) return;
        settled = true;
        resolve();
      });
    });
  });
}

/**
 * TLS syslog transport for ad-hoc {@link CefEvent}s (Issue #619). Reuses the
 * same connect/verify/timeout handling as {@link createCefSyslogTransport}.
 */
export function createSecurityEventSyslogTlsTransport(
  options: CefSyslogOptions,
  connect: typeof tls.connect = tls.connect
): SecurityEventTransport {
  return (event) => sendCefOverTls(formatCefEvent(event), options, connect);
}

/**
 * UDP syslog transport for ad-hoc {@link CefEvent}s (Issue #619). UDP is the
 * traditional (RFC 3164) syslog transport — lower overhead than TLS, no
 * delivery guarantee — offered alongside the TLS transport so operators can
 * choose per their SIEM's ingestion endpoint.
 */
export function createSecurityEventSyslogUdpTransport(
  options: CefSyslogUdpOptions,
  createUdpSocket: typeof createSocket = createSocket
): SecurityEventTransport {
  const timeoutMs = options.timeoutMs ?? 5_000;

  return (event) => new Promise<void>((resolve, reject) => {
    const socket = createUdpSocket("udp4");
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(new Error("CEF Syslog UDP send timed out"));
    }, timeoutMs);

    socket.once("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      reject(error);
    });

    const message = Buffer.from(`${formatCefEvent(event)}\n`, "utf8");
    socket.send(message, options.port, options.host, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

let securityEventTransport: SecurityEventTransport | undefined;

/** Configure (or clear, passing `undefined`) the ad-hoc security-event syslog transport. */
export function configureSecurityEventTransport(transport?: SecurityEventTransport): void {
  securityEventTransport = transport;
}

/**
 * Whether a {@link CefEvent} is high/critical severity — the acceptance
 * criteria for Issue #619 calls these out by name (unauthorized access,
 * encryption key changes) as requiring instant SIEM emission.
 */
export function isHighSeverityCefEvent(event: CefEvent): boolean {
  return event.severity === "high" || event.severity === "critical";
}

/**
 * Emit a security CEF event to the configured syslog transport straight
 * away: there is no batching/buffering window at any severity, so the
 * "instant emission" acceptance criterion for high/critical events holds
 * trivially, and lower-severity events get the same immediacy for free.
 * Mirrors {@link dispatchAuditLogEntry}'s fire-and-forget contract — a SIEM
 * outage must never throw back into (or block) the caller's request path.
 */
export function dispatchSecurityEvent(event: CefEvent): void {
  if (!securityEventTransport) return;
  try {
    void Promise.resolve(securityEventTransport(event)).catch(() => undefined);
  } catch {
    // A SIEM outage must not block or surface to the caller raising the event.
  }
}
