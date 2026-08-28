/**
 * Issue #158 — Custom Metrics SDK with auto-labeling, exemplars,
 * naming enforcement, high-cardinality sampling, and documentation generation.
 */

export type MetricType = "counter" | "gauge" | "histogram" | "summary";

export interface MetricLabelDef {
  name: string;
  description: string;
  required: boolean;
  values?: string[]; // allowed enum values
}

export interface MetricDefinition {
  name: string;
  type: MetricType;
  help: string;
  labels: MetricLabelDef[];
  unit?: string;
  buckets?: number[]; // for histogram
  objectives?: Record<number, number>; // for summary
}

export interface MetricExemplar {
  traceId: string;
  spanId: string;
  value: number;
  timestamp: string;
  labels: Record<string, string>;
}

export interface MetricSDKConfig {
  serviceName: string;
  serviceVersion: string;
  instanceId: string;
  environment: string;
  maxExemplarsPerMetric: number;
  samplingRate: number; // 0.0 to 1.0
}

export class Counter {
  private value = 0;
  private readonly exemplars: MetricExemplar[] = [];

  constructor(
    public readonly definition: MetricDefinition,
    private readonly baseLabels: Record<string, string>,
    private readonly defaultLabels: Record<string, string> = {}
  ) {}

  inc(val: number = 1, labels: Record<string, string> = {}, exemplar?: { traceId: string; spanId: string }): void {
    if (val < 0) {
      throw new Error(`Counter ${this.definition.name} cannot be incremented by negative value: ${val}`);
    }
    this.value += val;
    if (exemplar) {
      this.exemplars.push({
        traceId: exemplar.traceId,
        spanId: exemplar.spanId,
        value: val,
        timestamp: new Date().toISOString(),
        labels: { ...this.baseLabels, ...this.defaultLabels, ...labels },
      });
    }
  }

  get(): number {
    return this.value;
  }

  getExemplars(): MetricExemplar[] {
    return [...this.exemplars];
  }
}

export class Gauge {
  private value = 0;

  constructor(
    public readonly definition: MetricDefinition,
    _baseLabels: Record<string, string>,
    _defaultLabels: Record<string, string> = {}
  ) {}

  set(val: number): void {
    this.value = val;
  }

  inc(val: number = 1): void {
    this.value += val;
  }

  dec(val: number = 1): void {
    this.value -= val;
  }

  get(): number {
    return this.value;
  }
}

export class Histogram {
  private count = 0;
  private sum = 0;
  private readonly buckets: number[];
  private readonly bucketCounts: number[];
  private readonly exemplars: MetricExemplar[] = [];

  constructor(
    public readonly definition: MetricDefinition,
    private readonly baseLabels: Record<string, string>,
    private readonly defaultLabels: Record<string, string> = {}
  ) {
    this.buckets = definition.buckets ?? [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
    this.bucketCounts = new Array(this.buckets.length).fill(0);
  }

  observe(val: number, labels: Record<string, string> = {}, exemplar?: { traceId: string; spanId: string }): void {
    this.count++;
    this.sum += val;

    for (let i = 0; i < this.buckets.length; i++) {
      if (val <= this.buckets[i]) {
        this.bucketCounts[i]++;
      }
    }

    if (exemplar) {
      this.exemplars.push({
        traceId: exemplar.traceId,
        spanId: exemplar.spanId,
        value: val,
        timestamp: new Date().toISOString(),
        labels: { ...this.baseLabels, ...this.defaultLabels, ...labels },
      });
    }
  }

  get(): { count: number; sum: number; buckets: Array<{ le: number; count: number }> } {
    return {
      count: this.count,
      sum: this.sum,
      buckets: this.buckets.map((le, idx) => ({ le, count: this.bucketCounts[idx] })),
    };
  }

  getExemplars(): MetricExemplar[] {
    return [...this.exemplars];
  }
}

export class Summary {
  private count = 0;
  private sum = 0;
  private readonly values: number[] = [];

  constructor(
    public readonly definition: MetricDefinition,
    _baseLabels: Record<string, string>,
    _defaultLabels: Record<string, string> = {}
  ) {}

  observe(val: number): void {
    this.count++;
    this.sum += val;
    this.values.push(val);
  }

  get(): { count: number; sum: number; p50: number; p95: number; p99: number } {
    if (this.values.length === 0) {
      return { count: 0, sum: 0, p50: 0, p95: 0, p99: 0 };
    }
    const sorted = [...this.values].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;

    return { count: this.count, sum: this.sum, p50, p95, p99 };
  }
}

export class MetricsSDK {
  private readonly config: MetricSDKConfig;
  private readonly definitions = new Map<string, MetricDefinition>();
  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, Gauge>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly summaries = new Map<string, Summary>();

  constructor(config?: Partial<MetricSDKConfig>) {
    this.config = {
      serviceName: config?.serviceName ?? "delego-service",
      serviceVersion: config?.serviceVersion ?? "1.0.0",
      instanceId: config?.instanceId ?? "inst-1",
      environment: config?.environment ?? (process.env.NODE_ENV ?? "development"),
      maxExemplarsPerMetric: config?.maxExemplarsPerMetric ?? 100,
      samplingRate: config?.samplingRate ?? 1.0,
    };
  }

  private getAutoLabels(): Record<string, string> {
    return {
      service: this.config.serviceName,
      version: this.config.serviceVersion,
      instance: this.config.instanceId,
      env: this.config.environment,
    };
  }

  private validateMetricName(name: string): void {
    const validRegex = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
    if (!validRegex.test(name)) {
      throw new Error(`Invalid metric name "${name}": must match regex /^[a-zA-Z_:][a-zA-Z0-9_:]*$/`);
    }
  }

  register(definition: MetricDefinition): void {
    this.validateMetricName(definition.name);
    this.definitions.set(definition.name, definition);
  }

  unregister(name: string): void {
    this.definitions.delete(name);
    this.counters.delete(name);
    this.gauges.delete(name);
    this.histograms.delete(name);
    this.summaries.delete(name);
  }

  counter(name: string, labels?: Record<string, string>): Counter {
    let instance = this.counters.get(name);
    if (!instance) {
      const def = this.definitions.get(name) ?? {
        name,
        type: "counter",
        help: "Auto-registered counter",
        labels: [],
      };
      instance = new Counter(def, this.getAutoLabels(), labels);
      this.counters.set(name, instance);
    }
    return instance;
  }

  gauge(name: string, labels?: Record<string, string>): Gauge {
    let instance = this.gauges.get(name);
    if (!instance) {
      const def = this.definitions.get(name) ?? {
        name,
        type: "gauge",
        help: "Auto-registered gauge",
        labels: [],
      };
      instance = new Gauge(def, this.getAutoLabels(), labels);
      this.gauges.set(name, instance);
    }
    return instance;
  }

  histogram(name: string, labels?: Record<string, string>): Histogram {
    let instance = this.histograms.get(name);
    if (!instance) {
      const def = this.definitions.get(name) ?? {
        name,
        type: "histogram",
        help: "Auto-registered histogram",
        labels: [],
      };
      instance = new Histogram(def, this.getAutoLabels(), labels);
      this.histograms.set(name, instance);
    }
    return instance;
  }

  summary(name: string, labels?: Record<string, string>): Summary {
    let instance = this.summaries.get(name);
    if (!instance) {
      const def = this.definitions.get(name) ?? {
        name,
        type: "summary",
        help: "Auto-registered summary",
        labels: [],
      };
      instance = new Summary(def, this.getAutoLabels(), labels);
      this.summaries.set(name, instance);
    }
    return instance;
  }

  /**
   * Generates markdown documentation of all registered metrics.
   */
  generateDocs(): string {
    const lines: string[] = [
      "# Application Metrics Documentation",
      "",
      `*Generated for \`${this.config.serviceName}\` (${this.config.serviceVersion}) in \`${this.config.environment}\`*`,
      "",
      "| Metric Name | Type | Unit | Description | Labels |",
      "| :--- | :--- | :--- | :--- | :--- |",
    ];

    for (const def of this.definitions.values()) {
      const labelNames = def.labels.map((l) => `${l.name}${l.required ? "*" : ""}`).join(", ") || "None";
      lines.push(
        `| \`${def.name}\` | \`${def.type}\` | \`${def.unit ?? "count"}\` | ${def.help} | \`${labelNames}\` |`
      );
    }

    return lines.join("\n");
  }
}

// Global default SDK instance
export const metrics = new MetricsSDK();
