/**
 * Distributed tracing config, sampling, and span-attribute helpers
 * (Issue #73).
 *
 * Scoping note: this implements the sampling-decision logic and a
 * typed span-attribute builder as standalone, provider-agnostic pieces.
 * It does NOT integrate the OpenTelemetry SDK, configure automatic
 * HTTP/DB/Redis instrumentation, or stand up a Jaeger/Tempo collector —
 * those require adding a real OTel SDK dependency and a collector
 * endpoint, a toolchain/infra decision that shouldn't be made
 * unilaterally in this PR. `sampleTrace`/`buildSpanAttributes` are
 * exactly the two pieces of "business logic" in an OTel setup that
 * aren't just SDK configuration, and are independently testable without
 * a real OTel dependency.
 */

export type SamplerType = "always_on" | "always_off" | "trace_id_ratio" | "parent_based";
export type TraceExporterType = "jaeger" | "otlp" | "zipkin";
export type Propagator = "tracecontext" | "baggage" | "b3";

export interface TraceConfig {
  serviceName: string;
  sampler: SamplerType;
  sampleRate: number;
  exporter: TraceExporterType;
  endpoint: string;
  propagators: Propagator[];
}

export interface SpanAttributes {
  "http.method"?: string;
  "http.url"?: string;
  "http.status_code"?: number;
  "db.statement"?: string;
  "db.operation"?: string;
  "messaging.system"?: string;
  "messaging.destination"?: string;
  error?: boolean;
  "error.message"?: string;
}

export interface TraceMetrics {
  tracesReceived: number;
  spansReceived: number;
  samplingRate: number;
  avgSpansPerTrace: number;
  errorRate: number;
  latencyP50Ms: number;
  latencyP99Ms: number;
}

/**
 * Deterministically hash a trace id into [0, 1) for ratio-based sampling
 * — the same trace id always yields the same sampling decision, so a
 * trace sampled "in" at the root stays sampled "in" for every downstream
 * span (parent_based semantics rely on this).
 *
 * Uses FNV-1a (good avalanche behavior even for near-identical inputs,
 * e.g. sequential trace ids like "trace-1"/"trace-2") rather than a plain
 * polynomial rolling hash, which barely perturbs its output for inputs
 * differing only in a trailing character — real trace ids are typically
 * random hex, but sequential/near-identical ids do show up (tests,
 * synthetic load, some ID generators), and a sampler that clusters them
 * all into the same in/out decision defeats the point of ratio sampling.
 */
function hashTraceIdToUnitInterval(traceId: string): number {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < traceId.length; i++) {
    hash ^= traceId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0; // FNV prime (32-bit)
  }
  return hash / 0xffffffff;
}

export interface SampleContext {
  traceId: string;
  /** Whether the parent span (if any) was itself sampled. Required for
   * "parent_based" sampling; ignored otherwise. */
  parentSampled?: boolean;
  hasParent: boolean;
}

/**
 * Decide whether to sample a trace/span given `config` and `context`.
 * Pure function of (config, traceId, parent state) — no I/O, so this can
 * genuinely run at the "reduces volume 90%+" hot path the issue's AC
 * cares about without needing a real collector to test against.
 */
export function sampleTrace(config: TraceConfig, context: SampleContext): boolean {
  switch (config.sampler) {
    case "always_on":
      return true;
    case "always_off":
      return false;
    case "trace_id_ratio":
      return hashTraceIdToUnitInterval(context.traceId) < config.sampleRate;
    case "parent_based":
      if (context.hasParent) {
        return Boolean(context.parentSampled);
      }
      // No parent — fall back to ratio-based sampling for the root span.
      return hashTraceIdToUnitInterval(context.traceId) < config.sampleRate;
  }
}

/**
 * Build a typed SpanAttributes object from partial inputs, only including
 * keys that were actually provided — avoids polluting spans with
 * `undefined`-valued attributes that some exporters serialize as
 * `"undefined"` strings.
 */
export function buildSpanAttributes(input: Partial<SpanAttributes>): SpanAttributes {
  const attributes: SpanAttributes = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      (attributes as Record<string, unknown>)[key] = value;
    }
  }
  return attributes;
}

/** Build the span attributes for an HTTP request/response, marking it as
 * an error span for any 4xx/5xx status. */
export function buildHttpSpanAttributes(
  method: string,
  url: string,
  statusCode: number,
): SpanAttributes {
  return buildSpanAttributes({
    "http.method": method,
    "http.url": url,
    "http.status_code": statusCode,
    error: statusCode >= 400,
  });
}

/** Build the span attributes for a database call, redacting the
 * statement's literal values isn't this function's job (the caller
 * should pass an already-parameterized/redacted statement) — this only
 * shapes the attribute object. */
export function buildDbSpanAttributes(operation: string, statement: string): SpanAttributes {
  return buildSpanAttributes({ "db.operation": operation, "db.statement": statement });
}

export function buildErrorSpanAttributes(error: Error): SpanAttributes {
  return buildSpanAttributes({ error: true, "error.message": error.message });
}

/** Compute the p50/p99 latency for a set of span durations (ms), plus
 * error rate and avg spans/trace — the aggregate numbers this issue's AC
 * asks trace-based SLO dashboards to show. */
export function computeTraceMetrics(input: {
  traceCount: number;
  spanDurationsMs: number[];
  errorSpanCount: number;
}): TraceMetrics {
  const sorted = [...input.spanDurationsMs].sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p99 = percentile(sorted, 0.99);

  return {
    tracesReceived: input.traceCount,
    spansReceived: input.spanDurationsMs.length,
    samplingRate: 0, // populated by the caller from its configured TraceConfig
    avgSpansPerTrace: input.traceCount > 0 ? input.spanDurationsMs.length / input.traceCount : 0,
    errorRate: input.spanDurationsMs.length > 0 ? input.errorSpanCount / input.spanDurationsMs.length : 0,
    latencyP50Ms: p50,
    latencyP99Ms: p99,
  };
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.floor(p * sortedValues.length));
  return sortedValues[index];
}
