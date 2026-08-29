/**
 * Lua Script Management System with Versioning and Testing
 * Issue #156
 */

export interface LuaScript {
  name: string;
  version: string;
  sha: string;
  source: string;
  description: string;
  params: Array<{
    name: string;
    type: "KEYS" | "ARGV";
    description: string;
  }>;
  dependencies: string[];
  testCases: Array<{
    name: string;
    keys: string[];
    args: unknown[];
    expected: unknown;
  }>;
}

export interface ScriptDeployment {
  scriptName: string;
  version: string;
  status: "pending" | "deploying" | "deployed" | "failed" | "rolled_back";
  deployedAt: string;
  deployedBy: string;
  clusters: string[];
  rollbackVersion?: string;
}

export interface ScriptMetrics {
  scriptName: string;
  version: string;
  executions: number;
  avgDurationMs: number;
  p99DurationMs: number;
  errors: number;
  errorRate: number;
  lastExecutedAt: string;
}

export interface ScriptVersion {
  version: string;
  sha: string;
  createdAt: string;
  createdBy: string;
  changelog: string;
  status: "draft" | "active" | "deprecated" | "archived";
}

export interface ScriptRegistry {
  name: string;
  currentVersion: string;
  versions: ScriptVersion[];
  dependencies: string[];
  lastDeployedAt?: string;
  deploymentStatus: "none" | "deployed" | "failed";
}

export interface ScriptTestResult {
  passed: boolean;
  testName: string;
  expected: unknown;
  actual: unknown;
  error?: string;
  durationMs: number;
}

export interface ScriptTestSuite {
  scriptName: string;
  version: string;
  results: ScriptTestResult[];
  passed: number;
  failed: number;
  total: number;
  durationMs: number;
}
