/**
 * Prometheus-style service metrics registry (Issue #74).
 *
 * A minimal, dependency-free RED (Rate/Errors/Duration) + business metrics
 * registry that a service can expose via a `/metrics` endpoint in
 * Prometheus text exposition format. Deliberately does not depend on
 * `prom-client` so it stays trivial to unit test and swap out; a service
 * that wants richer Prometheus semantics (histograms with real bucket
 * math, etc.) can still use this module's types as the contract and back
 * them with `prom-client` internally.
 *
 * Out of scope for this change (left as follow-ups — these require actual
 * infrastructure/deployment, not just application code): Grafana dashboard
 * JSON definitions, Alertmanager routing configuration, and synthetic
 * monitoring checks. This module defines `AlertRule`'s shape so those
 * configs have a typed contract to target once built.
 */

export interface Counter {
  inc(value?: number, labels?: Record<string, string>): void;
  value(labels?: Record<string, string>): number;
}

export interface Gauge {
  set(value: number, labels?: Record<string, string>): void;
  inc(value?: number, labels?: Record<string, string>): void;
  dec(value?: number, labels?: Record<string, string>): void;
  value(labels?: Record<string, string>): number;
}

export interface Histogram {
  observe(value: number, labels?: Record<string, string>): void;
  /** Total count of observations recorded. */
  count(labels?: Record<string, string>): number;
  /** Sum of all observed values, for computing an average alongside count. */
  sum(labels?: Record<string, string>): number;
}

function labelKey(labels?: Record<string, string>): string {
  if (!labels) return "";
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

class SimpleCounter implements Counter {
  private values = new Map<string, number>();

  inc(value = 1, labels?: Record<string, string>): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + value);
  }

  value(labels?: Record<string, string>): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }
}

class SimpleGauge implements Gauge {
  private values = new Map<string, number>();

  set(value: number, labels?: Record<string, string>): void {
    this.values.set(labelKey(labels), value);
  }
  inc(value = 1, labels?: Record<string, string>): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + value);
  }
  dec(value = 1, labels?: Record<string, string>): void {
    this.inc(-value, labels);
  }
  value(labels?: Record<string, string>): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }
}

class SimpleHistogram implements Histogram {
  private counts = new Map<string, number>();
  private sums = new Map<string, number>();

  observe(value: number, labels?: Record<string, string>): void {
    const key = labelKey(labels);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
  }
  count(labels?: Record<string, string>): number {
    return this.counts.get(labelKey(labels)) ?? 0;
  }
  sum(labels?: Record<string, string>): number {
    return this.sums.get(labelKey(labels)) ?? 0;
  }
}

/** Standard RED (Rate, Errors, Duration) metrics every instrumented service exposes. */
export interface RedMetrics {
  httpRequestsTotal: Counter;
  httpRequestDurationSeconds: Histogram;
  httpErrorsTotal: Counter;
}

export interface AlertRule {
  name: string;
  /** PromQL expression. */
  expr: string;
  /** Duration the condition must hold before firing, e.g. "5m". */
  for: string;
  labels: Record<string, string>;
  annotations: {
    summary: string;
    description: string;
    runbookUrl: string;
  };
  severity: "critical" | "warning" | "info";
}

/**
 * Registry a service instantiates once and instruments its request path
 * with. `register()` lazily creates named counters/gauges/histograms of a
 * given kind, so call sites don't need to pre-declare every business
 * metric up front.
 */
export class ServiceMetricsRegistry {
  private counters = new Map<string, SimpleCounter>();
  private gauges = new Map<string, SimpleGauge>();
  private histograms = new Map<string, SimpleHistogram>();

  readonly red: RedMetrics = {
    httpRequestsTotal: this.counter("http_requests_total"),
    httpRequestDurationSeconds: this.histogram("http_request_duration_seconds"),
    httpErrorsTotal: this.counter("http_errors_total"),
  };

  counter(name: string): Counter {
    let existing = this.counters.get(name);
    if (!existing) {
      existing = new SimpleCounter();
      this.counters.set(name, existing);
    }
    return existing;
  }

  gauge(name: string): Gauge {
    let existing = this.gauges.get(name);
    if (!existing) {
      existing = new SimpleGauge();
      this.gauges.set(name, existing);
    }
    return existing;
  }

  histogram(name: string): Histogram {
    let existing = this.histograms.get(name);
    if (!existing) {
      existing = new SimpleHistogram();
      this.histograms.set(name, existing);
    }
    return existing;
  }

  /** Records one completed HTTP request against the RED metrics in one call. */
  recordHttpRequest(
    durationSeconds: number,
    labels: { method: string; route: string; statusCode: number },
  ): void {
    const labelSet = {
      method: labels.method,
      route: labels.route,
      status: String(labels.statusCode),
    };
    this.red.httpRequestsTotal.inc(1, labelSet);
    this.red.httpRequestDurationSeconds.observe(durationSeconds, labelSet);
    if (labels.statusCode >= 500) {
      this.red.httpErrorsTotal.inc(1, labelSet);
    }
  }

  /** Renders every registered metric in Prometheus text exposition format. */
  toPrometheusText(): string {
    const lines: string[] = [];
    for (const [name, counter] of this.counters) {
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name} ${counter.value()}`);
    }
    for (const [name, gauge] of this.gauges) {
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${gauge.value()}`);
    }
    for (const [name, hist] of this.histograms) {
      lines.push(`# TYPE ${name} histogram`);
      lines.push(`${name}_count ${hist.count()}`);
      lines.push(`${name}_sum ${hist.sum()}`);
    }
    return lines.join("\n") + "\n";
  }
}
