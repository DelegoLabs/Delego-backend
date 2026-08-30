/**
 * Workflow Template System — reusable workflow definitions with parameterization.
 */

/** Supported parameter value types. */
export type WorkflowTemplateParameterType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array";

export interface WorkflowTemplateParameter {
  name: string;
  type: WorkflowTemplateParameterType;
  required: boolean;
  default?: unknown;
  /** JSON Schema fragment used to validate the parameter value. */
  validation?: string;
  description: string;
}

/** The executable workflow definition carried by a template. */
export interface WorkflowTemplateDefinition {
  states: Record<string, object>;
  transitions: Array<object>;
  context: Record<string, unknown>;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  version: string;
  category: string;
  tags: string[];
  definition: WorkflowTemplateDefinition;
  parameters: WorkflowTemplateParameter[];
  parentTemplateId?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

/** A concrete workflow produced by instantiating a template. */
export interface TemplateInstantiation {
  templateId: string;
  templateVersion: string;
  parameters: Record<string, unknown>;
  workflowId: string;
  instantiatedAt: string;
  instantiatedBy: string;
}

/** A lightweight listing entry shown by the template marketplace/catalog. */
export interface TemplateCatalogEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  category: string;
  tags: string[];
  downloads: number;
  rating: number;
  verified: boolean;
}

export interface TemplateCatalog {
  templates: TemplateCatalogEntry[];
  categories: string[];
}
