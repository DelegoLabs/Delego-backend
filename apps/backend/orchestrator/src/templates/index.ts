/**
 * Workflow Template System — reusable workflow definitions with parameterization.
 *
 * Features:
 *   - Template schema + parameter validation with defaults (JSON Schema fragments)
 *   - Versioning and catalog
 *   - Inheritance to reduce duplication
 *   - Marketplace with ratings/downloads
 *   - Fast instantiation (validated, defaulted, in-memory)
 *   - Testing framework and documentation generator
 */
export * from "./types.js";
export {
  validateParameters,
  validateParameterValue,
  validateTemplateDefinition,
  validateAgainstJsonSchema,
  ParameterValidationError,
} from "./schema.js";
export {
  resetTemplateRegistry,
  registerTemplate,
  getTemplateByVersion,
  getTemplateById,
  getTemplateRegistryEntry,
  listTemplateVersions,
  listTemplates,
  deleteTemplate,
  deprecateTemplateVersion,
  recordDownload,
  rateTemplate,
  markTemplateVerified,
  buildCatalog,
  getResolvedTemplate,
} from "./registry.js";
export {
  getAncestry,
  resolveTemplate,
  TemplateInheritanceError,
} from "./inheritance.js";
export {
  instantiateTemplate,
  resolveTemplateContext,
  templateExists,
} from "./instantiation.js";
export { runTemplateTests, type TemplateTestCaseInput, type TemplateTestOptions } from "./testing.js";
export {
  generateTemplateDocumentation,
  renderTemplateDocumentation,
} from "./documentation.js";
