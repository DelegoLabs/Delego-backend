/**
 * Workflow template module types.
 */
import type {
  TemplateCatalogEntry,
  WorkflowTemplateDefinition,
  WorkflowTemplateParameter,
  WorkflowTemplateParameterType,
} from "@delegolabs/types";

export {
  WorkflowTemplateDefinition,
  WorkflowTemplateParameter,
  WorkflowTemplateParameterType,
  TemplateCatalogEntry,
};

/** A parameter resolved through inheritance (definition + origin template). */
export interface InheritedParameter {
  parameter: WorkflowTemplateParameter;
  originTemplateId: string;
}

/** The fully merged definition after applying inheritance. */
export interface ResolvedTemplate {
  templateId: string;
  name: string;
  description: string;
  version: string;
  category: string;
  tags: string[];
  definition: WorkflowTemplateDefinition;
  parameters: WorkflowTemplateParameter[];
  parentTemplateId?: string;
}

/** Outcome of validating a set of provided values against a template's parameters. */
export interface ParameterValidationResult {
  valid: boolean;
  /** Values with defaults applied for missing optional parameters. */
  resolved: Record<string, unknown>;
  errors: string[];
}

/** Instantiation request payload. */
export interface InstantiateTemplateInput {
  templateId: string;
  /** Optional; defaults to the template's current/latest version. */
  templateVersion?: string;
  parameters: Record<string, unknown>;
  instantiatedBy: string;
  /** Optional opaque id for the produced workflow; generated otherwise. */
  workflowId?: string;
}

/** A concrete workflow produced by instantiation. */
export interface TemplateInstantiationRecord {
  templateId: string;
  templateVersion: string;
  parameters: Record<string, unknown>;
  workflowId: string;
  instantiatedAt: string;
  instantiatedBy: string;
}

/** Registry metadata tracked per template (versions + marketplace stats). */
export interface TemplateVersionMeta {
  version: string;
  createdAt: string;
  createdBy: string;
  changelog: string;
  status: "active" | "deprecated" | "archived";
}

export interface TemplateRegistryEntry {
  id: string;
  currentVersion: string;
  versions: TemplateVersionMeta[];
  downloads: number;
  rating: number;
  ratingsCount: number;
  verified: boolean;
}

export interface RateTemplateInput {
  rating: number;
  ratedBy: string;
}

/** A single executed test case within the template testing framework. */
export interface TemplateTestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

export interface TemplateTestSuite {
  templateId: string;
  version: string;
  results: TemplateTestResult[];
  passed: number;
  failed: number;
  total: number;
  durationMs: number;
  /** True when every test passed — used to signal "verified" on the catalog. */
  verified: boolean;
}

/** A documented section of a template, produced by the documentation generator. */
export interface TemplateDocSection {
  title: string;
  body: string;
}

export interface TemplateDocumentation {
  templateId: string;
  name: string;
  version: string;
  generatedAt: string;
  markdown: string;
  sections: TemplateDocSection[];
}
