/**
 * Test Coverage and CI Quality Gates Types
 * Issue #85
 */

export interface CoverageMetric {
  covered: number;
  total: number;
  pct: number;
}

export interface CoverageMetricsGroup {
  lines: CoverageMetric;
  functions: CoverageMetric;
  branches: CoverageMetric;
  statements: CoverageMetric;
}

export interface CoverageConfig {
  lines: number;
  functions: number;
  branches: number;
  statements: number;
  excludePaths: string[];
  thresholdAutoUpdate: boolean;
}

export interface CoverageReport {
  total: CoverageMetricsGroup;
  byFile: Record<
    string,
    {
      lines: CoverageMetric;
      functions: CoverageMetric;
      branches: CoverageMetric;
      statements: CoverageMetric;
    }
  >;
}

export interface MutationTestResult {
  killed: number;
  survived: number;
  timeout: number;
  noCoverage: number;
  mutationScore: number;
}

export interface CoverageGateEvaluation {
  passed: boolean;
  failures: string[];
  summary: {
    lines: { current: number; required: number; passed: boolean };
    branches: { current: number; required: number; passed: boolean };
    functions: { current: number; required: number; passed: boolean };
    statements: { current: number; required: number; passed: boolean };
    mutationScore?: { current: number; required: number; passed: boolean };
  };
}
