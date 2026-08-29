/**
 * Structured log formatting, query building, and retention policy
 * validation (Issue #75).
 *
 * Scoping note: this implements the structured-JSON log shape and
 * retention-policy validation as standalone, provider-agnostic pieces.
 * It does NOT deploy a Loki/Elasticsearch cluster, configure
 * fluent-bit/vector log shipping, or build a log-search UI — those
 * require real infrastructure and a storage-backend decision that
 * shouldn't be made unilaterally in this PR. This repo's existing
 * `createLogger` (./logger.ts) already emits structured JSON per-line —
 * `formatLogEntry` here formalizes that shape into the typed LogEntry
 * contract this issue specifies, so a future log shipper has a stable
 * schema to target regardless of which backend receives it.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  traceId?: string;
  spanId?: string;
  message: string;
  fields: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack: string;
  };
}

export interface LogQuery {
  service?: string;
  level?: string;
  traceId?: string;
  startTime: string;
  endTime: string;
  filter?: string;
  limit: number;
}

export type StorageClass = "hot" | "warm" | "cold";

export interface LogRetentionPolicy {
  level: string;
  retentionDays: number;
  storageClass: StorageClass;
  compressionEnabled: boolean;
}

export interface LogMetrics {
  ingestionRate: number;
  errorRate: number;
  avgLatencyMs: number;
  storageUsed: number;
  retentionCompliance: boolean;
}

/** Build a structured LogEntry, matching the RFC3339 timestamp / typed
 * error shape this issue's schema specifies. */
export function formatLogEntry(input: {
  level: LogLevel;
  service: string;
  message: string;
  fields?: Record<string, unknown>;
  traceId?: string;
  spanId?: string;
  error?: Error;
  now?: () => Date;
}): LogEntry {
  const now = input.now ?? (() => new Date());
  const entry: LogEntry = {
    timestamp: now().toISOString(),
    level: input.level,
    service: input.service,
    message: input.message,
    fields: input.fields ?? {},
  };
  if (input.traceId) entry.traceId = input.traceId;
  if (input.spanId) entry.spanId = input.spanId;
  if (input.error) {
    entry.error = {
      name: input.error.name,
      message: input.error.message,
      stack: input.error.stack ?? "",
    };
  }
  return entry;
}

/** Serialize a LogEntry to a single JSON line, the shape a log shipper
 * (fluent-bit/vector) would tail and forward. */
export function serializeLogEntry(entry: LogEntry): string {
  return JSON.stringify(entry);
}

const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };

/** Check whether a LogEntry matches a LogQuery's filters (service, level
 * floor, traceId, and time range) — the selection logic a query endpoint
 * would apply, independent of which storage backend actually executes it. */
export function matchesLogQuery(entry: LogEntry, query: LogQuery): boolean {
  if (query.service && entry.service !== query.service) return false;
  if (query.traceId && entry.traceId !== query.traceId) return false;
  if (query.level && LOG_LEVEL_SEVERITY[entry.level] < LOG_LEVEL_SEVERITY[query.level as LogLevel]) {
    return false;
  }

  const entryTime = new Date(entry.timestamp).getTime();
  const start = new Date(query.startTime).getTime();
  const end = new Date(query.endTime).getTime();
  if (entryTime < start || entryTime > end) return false;

  if (query.filter && !entry.message.includes(query.filter)) return false;

  return true;
}

export interface RetentionValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a set of retention policies: every log level should have a
 * policy, retention days should be positive, and — per this issue's AC
 * ("30-day hot, 1-year cold") — a hot-tier policy shouldn't outlive its
 * warm/cold tiers (that would be a nonsensical storage-cost ordering).
 */
export function validateRetentionPolicies(policies: LogRetentionPolicy[]): RetentionValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byLevel = new Map(policies.map((p) => [p.level, p]));

  const allLevels: LogLevel[] = ["debug", "info", "warn", "error", "fatal"];
  for (const level of allLevels) {
    if (!byLevel.has(level)) {
      warnings.push(`No retention policy defined for level '${level}'`);
    }
  }

  for (const policy of policies) {
    if (policy.retentionDays <= 0) {
      errors.push(`Retention policy for '${policy.level}' has non-positive retentionDays`);
    }
  }

  const storageOrder: Record<StorageClass, number> = { hot: 0, warm: 1, cold: 2 };
  for (const a of policies) {
    for (const b of policies) {
      if (a === b) continue;
      const aTier = storageOrder[a.storageClass];
      const bTier = storageOrder[b.storageClass];
      if (aTier < bTier && a.retentionDays > b.retentionDays) {
        errors.push(
          `Policy for '${a.level}' (${a.storageClass}, ${a.retentionDays}d) retains longer than '${b.level}' (${b.storageClass}, ${b.retentionDays}d) despite being a hotter (more expensive) tier`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Check whether current metrics satisfy this issue's stated SLOs
 * (search < 2s is a query-latency concern outside this function's scope;
 * this checks the ingestion/error/retention-compliance metrics
 * LogMetrics actually reports). */
export function isLogPipelineHealthy(metrics: LogMetrics): boolean {
  return metrics.retentionCompliance && metrics.errorRate < 0.01;
}
