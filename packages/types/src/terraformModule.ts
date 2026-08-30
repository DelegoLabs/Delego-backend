/**
 * Reusable Terraform module schema types (Issue #96).
 *
 * Scoping note: this defines a schema for describing a Terraform module's
 * public contract (inputs/outputs/dependencies) and its test cases, so
 * module documentation and test coverage can be reviewed/validated
 * consistently across modules. It intentionally does NOT write actual
 * Terraform HCL for VPC/EKS/RDS/etc modules, run Terratest, or set up a
 * private module registry — those require real cloud provider access and
 * infra decisions that shouldn't be made unilaterally in this PR.
 */

export interface TerraformModuleInput {
  name: string;
  type: string;
  description: string;
  required: boolean;
  default?: unknown;
  validation?: string;
}

export interface TerraformModuleOutput {
  name: string;
  description: string;
  sensitive: boolean;
}

export interface TerraformModule {
  name: string;
  version: string;
  source: string;
  inputs: TerraformModuleInput[];
  outputs: TerraformModuleOutput[];
  dependencies: string[];
  documentation: string;
}

export interface ModuleTestCase {
  name: string;
  inputs: Record<string, unknown>;
  expectedOutputs: Record<string, unknown>;
  assertions: string[];
}

export interface ModuleTest {
  moduleName: string;
  testCases: ModuleTestCase[];
}

export type DriftType = "added" | "removed" | "modified";
export type DriftSeverity = "low" | "medium" | "high";

export interface DriftDetection {
  resourceId: string;
  expectedState: Record<string, unknown>;
  actualState: Record<string, unknown>;
  driftType: DriftType;
  severity: DriftSeverity;
  detectedAt: string;
}
