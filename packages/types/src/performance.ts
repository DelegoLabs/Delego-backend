/**
 * Performance Testing & k6 Budgets Types
 * Issue #89
 */

export interface PerformanceTestStage {
  duration: string;
  target: number; // VUs
}

export interface PerformanceTest {
  name: string;
  type: "load" | "stress" | "soak" | "spike";
  stages: PerformanceTestStage[];
  thresholds: {
    http_req_duration: string[]; // e.g., ["p(95)<500"]
    http_req_failed: string[]; // e.g., ["rate<0.01"]
    checks: string[]; // e.g., ["rate>0.99"]
  };
  scenarios: Record<
    string,
    {
      executor: string;
      exec: string;
      startVUs: number;
    }
  >;
}

export interface PerformanceBudget {
  endpoint: string;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  throughputRps: number;
  errorRate: number;
  availability: number;
}

export interface PerformanceMetrics {
  httpReqDuration: {
    avg: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
  httpReqFailed: {
    rate: number;
    count: number;
  };
  vus: number;
  iterations: number;
}

export interface PerformanceThresholdResult {
  name: string;
  passed: boolean;
  value: number;
}

export interface PerformanceResult {
  testName: string;
  passed: boolean;
  metrics: PerformanceMetrics;
  thresholds: PerformanceThresholdResult[];
  regressionDetected: boolean;
}
