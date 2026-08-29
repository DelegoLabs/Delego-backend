import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { json, createLogger } from "@delegolabs/utils";
import { getRequestContext } from "./requestId.js";

export type RASPMode = "monitor" | "block" | "log_only";
export type RASPCategory = "sql_injection" | "xss" | "command_injection" | "path_traversal" | "deserialization" | "custom";
export type RASPSeverity = "low" | "medium" | "high" | "critical";
export type RASPAction = "block" | "alert" | "log";

export interface RASPConfig {
  enabled: boolean;
  mode: RASPMode;
  rules: Array<{
    id: string;
    name: string;
    category: RASPCategory;
    severity: RASPSeverity;
    action: RASPAction;
    pattern: string;
    enabled: boolean;
  }>;
  trustedPaths: string[];
  trustedIPs: string[];
  samplingRate: number;
}

export interface RASPEvent {
  id: string;
  timestamp: string;
  ruleId: string;
  category: string;
  severity: string;
  action: "blocked" | "alerted" | "logged";
  request: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
    clientIP: string;
  };
  matchedPattern: string;
  traceId?: string;
}

export interface RASPMetrics {
  totalEvents: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
  byAction: Record<string, number>;
  falsePositiveRate: number;
  avgLatencyMs: number;
  blockedRequests: number;
}

const log = createLogger("gateway:rasp", process.env.LOG_LEVEL ?? "info");
const DEFAULT_RULES: RASPConfig["rules"] = [
  { id: "rasp-sqli", name: "SQL injection", category: "sql_injection", severity: "critical", action: "block", pattern: "(?:union\\s+select|(?:or|and)\\s+['\\\"]?1['\\\"]?\\s*=|sleep\\s*\\()", enabled: true },
  { id: "rasp-xss", name: "Cross-site scripting", category: "xss", severity: "high", action: "block", pattern: "(?:<script\\b|javascript:|on(?:error|load|click)\\s*=)", enabled: true },
  { id: "rasp-command", name: "Command injection", category: "command_injection", severity: "critical", action: "block", pattern: "(?:[;&|`]\\s*(?:cat|curl|wget|bash|sh|rm)\\b|\\$\\([^)]*\\))", enabled: true },
  { id: "rasp-traversal", name: "Path traversal", category: "path_traversal", severity: "high", action: "block", pattern: "(?:\\.\\./|%2e%2e%2f|%2fetc%2fpasswd)", enabled: true },
  { id: "rasp-deserialization", name: "Unsafe deserialization", category: "deserialization", severity: "critical", action: "block", pattern: "(?:__proto__|constructor\\[|java\\.lang\\.|\\$type\\s*:)", enabled: true },
];

const metrics: RASPMetrics = { totalEvents: 0, byCategory: {}, bySeverity: {}, byAction: {}, falsePositiveRate: 0, avgLatencyMs: 0, blockedRequests: 0 };
let totalDetectionMs = 0;
let evaluationCount = 0;
const events: RASPEvent[] = [];

function parseConfig(): RASPConfig {
  let rules = DEFAULT_RULES;
  if (process.env.RASP_RULES) {
    try { rules = JSON.parse(process.env.RASP_RULES) as RASPConfig["rules"]; } catch { log.warn("Invalid RASP_RULES; using defaults"); }
  }
  return {
    enabled: process.env.RASP_ENABLED !== "false",
    mode: (process.env.RASP_MODE as RASPMode | undefined) ?? "block",
    rules,
    trustedPaths: (process.env.RASP_TRUSTED_PATHS ?? "/health,/.well-known").split(",").filter(Boolean),
    trustedIPs: (process.env.RASP_TRUSTED_IPS ?? "").split(",").map((ip) => ip.trim()).filter(Boolean),
    samplingRate: Math.min(1, Math.max(0, Number(process.env.RASP_SAMPLING_RATE ?? "1"))),
  };
}

function headerMap(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value ?? ""]));
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  return (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : req.socket.remoteAddress) ?? "unknown";
}

function isTrusted(path: string, ip: string, config: RASPConfig): boolean {
  return config.trustedIPs.includes(ip) || config.trustedPaths.some((trusted) => path === trusted || path.startsWith(`${trusted}/`));
}

function recordEvent(event: RASPEvent): void {
  events.push(event);
  if (events.length > 1000) events.shift();
  metrics.totalEvents += 1;
  metrics.byCategory[event.category] = (metrics.byCategory[event.category] ?? 0) + 1;
  metrics.bySeverity[event.severity] = (metrics.bySeverity[event.severity] ?? 0) + 1;
  metrics.byAction[event.action] = (metrics.byAction[event.action] ?? 0) + 1;
  if (event.action === "blocked") metrics.blockedRequests += 1;
  log.warn("RASP security event", event as unknown as Record<string, unknown>);
}

export function getRASPConfig(): RASPConfig { return parseConfig(); }
export function getRASPMetrics(): RASPMetrics { return { ...metrics, byCategory: { ...metrics.byCategory }, bySeverity: { ...metrics.bySeverity }, byAction: { ...metrics.byAction } }; }
export function getRASPEvents(): RASPEvent[] { return events.map((event) => ({ ...event, request: { ...event.request } })); }
export function resetRASPMetrics(): void {
  Object.assign(metrics, { totalEvents: 0, byCategory: {}, bySeverity: {}, byAction: {}, falsePositiveRate: 0, avgLatencyMs: 0, blockedRequests: 0 });
  totalDetectionMs = 0;
  evaluationCount = 0;
  events.length = 0;
}

export function createRASPEvent(req: IncomingMessage, rule: RASPConfig["rules"][number], action: RASPEvent["action"], body: string, pattern: string): RASPEvent {
  const path = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
  return { id: randomUUID(), timestamp: new Date().toISOString(), ruleId: rule.id, category: rule.category, severity: rule.severity, action, request: { method: req.method ?? "GET", path, headers: headerMap(req), body: body.slice(0, 10_000), clientIP: clientIp(req) }, matchedPattern: pattern, traceId: getRequestContext(req)?.requestId };
}

export function raspMiddleware(config: RASPConfig = parseConfig()) {
  return async (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): Promise<void> => {
    if (!config.enabled) { next(); return; }
    const started = performance.now();
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const ip = clientIp(req);
    if (isTrusted(url.pathname, ip, config) || Math.random() > config.samplingRate) { next(); return; }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    await new Promise<void>((resolve) => req.readableEnded ? resolve() : req.once("end", resolve));
    const body = Buffer.concat(chunks).toString("utf8");
    const input = decodeURIComponent(`${url.pathname}?${req.url ?? ""} ${body}`);
    const rule = config.rules.find((candidate) => candidate.enabled && new RegExp(candidate.pattern, "i").test(input));
    const elapsed = performance.now() - started;
    totalDetectionMs += elapsed;
    evaluationCount += 1;
    metrics.avgLatencyMs = totalDetectionMs / evaluationCount;
    if (!rule) { next(); return; }

    const shouldBlock = config.mode === "block" && rule.action === "block";
    const action: RASPEvent["action"] = shouldBlock ? "blocked" : rule.action === "alert" ? "alerted" : "logged";
    recordEvent(createRASPEvent(req, rule, action, body, rule.pattern));
    if (shouldBlock) {
      json(res, 403, { data: null, error: { code: "RASP_REQUEST_BLOCKED", message: "Request blocked by runtime application protection" } });
      return;
    }
    next();
  };
}

export function simulateRASPAttack(input: { method?: string; path: string; body?: string; ip?: string }, config: RASPConfig = parseConfig()): RASPEvent | null {
  const req = { method: input.method ?? "GET", url: input.path, headers: { host: "simulation" }, socket: { remoteAddress: input.ip ?? "127.0.0.1" } } as unknown as IncomingMessage;
  const candidate = config.rules.find((rule) => rule.enabled && new RegExp(rule.pattern, "i").test(`${input.path} ${input.body ?? ""}`));
  if (!candidate) return null;
  const event = createRASPEvent(req, candidate, candidate.action === "block" && config.mode === "block" ? "blocked" : candidate.action === "alert" ? "alerted" : "logged", input.body ?? "", candidate.pattern);
  recordEvent(event);
  return event;
}
