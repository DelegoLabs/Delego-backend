/**
 * Template instantiation — validates caller-supplied parameters against a
 * template's (inheritance-resolved) parameter schema, applies defaults, and
 * produces a concrete workflow definition with the values interpolated into the
 * context. Instantiation is a single-pass in-memory operation (well under 1s).
 */
import { createLogger, generateId } from "@delegolabs/utils";
import { InstantiateTemplateInput, TemplateInstantiationRecord } from "./types.js";
import { ParameterValidationError, validateParameters } from "./schema.js";
import { getResolvedTemplate, getTemplateByVersion, recordDownload } from "./registry.js";

export { TemplateInstantiationRecord };
export { ParameterValidationError };

const log = createLogger("orchestrator:templates:instantiation", process.env.LOG_LEVEL ?? "info");

/**
 * Instantiates a template into a runnable workflow definition.
 *
 * @param input - The instantiation request.
 * @param getResolved - Template resolver; defaults to the registry implementation.
 * @returns The instantiation record plus the concrete workflow definition.
 */
export async function instantiateTemplate(
  input: InstantiateTemplateInput,
  getResolved: typeof getResolvedTemplate = getResolvedTemplate,
): Promise<{
  workflow: TemplateInstantiationRecord;
  definition: {
    states: Record<string, object>;
    transitions: Array<object>;
    context: Record<string, unknown>;
  };
}> {
  const start = Date.now();

  const resolved = getResolved(input.templateId, input.templateVersion);
  if (!resolved) {
    throw new Error(`Template "${input.templateId}" not found`);
  }

  const validation = validateParameters(resolved.parameters, input.parameters ?? {});
  if (!validation.valid) {
    const err = new ParameterValidationError(validation.errors);
    log.warn("Template instantiation rejected", {
      templateId: input.templateId,
      errors: validation.errors,
    });
    throw err;
  }

  recordDownload(input.templateId);

  const workflowId = input.workflowId ?? `wf_${generateId()}`;

  // Interpolate resolved parameters into the template's static context.
  const context: Record<string, unknown> = {
    ...resolved.definition.context,
    ...validation.resolved,
    templateId: input.templateId,
    templateVersion: resolved.version,
  };

  const record: TemplateInstantiationRecord = {
    templateId: input.templateId,
    templateVersion: resolved.version,
    parameters: validation.resolved,
    workflowId,
    instantiatedAt: new Date().toISOString(),
    instantiatedBy: input.instantiatedBy,
  };

  log.info("Template instantiated", {
    templateId: input.templateId,
    version: resolved.version,
    workflowId,
    durationMs: Date.now() - start,
  });

  return {
    workflow: record,
    definition: {
      states: resolved.definition.states,
      transitions: resolved.definition.transitions,
      context,
    },
  };
}

/** Returns the concrete context for a template version after applying defaults. */
export function resolveTemplateContext(
  templateId: string,
  parameters: Record<string, unknown>,
  version?: string,
): Record<string, unknown> {
  const resolved = getResolvedTemplate(templateId, version);
  if (!resolved) throw new Error(`Template "${templateId}" not found`);
  const validation = validateParameters(resolved.parameters, parameters ?? {});
  if (!validation.valid) {
    throw new ParameterValidationError(validation.errors);
  }
  return {
    ...resolved.definition.context,
    ...validation.resolved,
    templateId,
    templateVersion: resolved.version,
  };
}

/** True when the template id + version resolve to a concrete template. */
export function templateExists(
  templateId: string,
  version?: string,
  getByVersion: typeof getTemplateByVersion = getTemplateByVersion,
): boolean {
  return getByVersion(templateId, version) !== null;
}
