/**
 * Comprehensive CI/CD Pipeline Types
 * Issue #91
 */

export interface PipelineStep {
  name: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  if?: string;
}

export interface PipelineJob {
  name: string;
  runsOn: string;
  steps: PipelineStep[];
  needs?: string[];
  timeoutMinutes: number;
}

export interface PipelineStage {
  name: string;
  jobs: PipelineJob[];
  timeoutMinutes: number;
}

export interface PipelineConfig {
  triggers: {
    push: string[];
    pullRequest: string[];
    schedule: Array<{ cron: string; branch: string }>;
    manual: boolean;
  };
  environments: {
    staging: { autoDeploy: boolean; approvalRequired: boolean };
    production: { autoDeploy: boolean; approvalRequired: boolean };
  };
  securityGates: {
    sast: boolean;
    dast: boolean;
    dependencyScan: boolean;
    secretScan: boolean;
    containerScan: boolean;
  };
}

export interface DeploymentResult {
  environment: string;
  version: string;
  status: "success" | "failed" | "rolled_back";
  deployedAt: string;
  deployedBy: string;
  rollbackVersion?: string;
  healthChecks: Array<{ name: string; passed: boolean }>;
}
