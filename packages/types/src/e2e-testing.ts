/**
 * End-to-End (E2E) Testing Types
 * Issue #87
 */

export type E2EAction = "navigate" | "click" | "fill" | "assert" | "wait" | "api_call";

export interface E2ETestStep {
  action: E2EAction;
  selector?: string;
  value?: string;
  url?: string;
  expectedResult?: unknown;
  timeoutMs?: number;
}

export interface E2ETestJourney {
  name: string;
  description: string;
  tags: string[];
  steps: E2ETestStep[];
  cleanup?: () => Promise<void>;
}

export interface E2ETestConfig {
  baseUrl: string;
  browsers: ("chromium" | "firefox" | "webkit")[];
  viewport: { width: number; height: number };
  retries: number;
  timeout: number;
  video: boolean;
  trace: boolean;
}

export interface E2ETestStepResult {
  step: number;
  action: E2EAction;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  error?: string;
  screenshot?: string;
}

export interface E2ETestResult {
  journey: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  steps: E2ETestStepResult[];
  videoUrl?: string;
  traceUrl?: string;
}

export interface E2ESuiteSummary {
  totalJourneys: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  results: E2ETestResult[];
}
