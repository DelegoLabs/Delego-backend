/**
 * Workflow template parameter validation, defaults, and definition schema checks.
 *
 * Each template declares a list of `parameters`. When a template is instantiated
 * the caller supplies values; this module validates them against each parameter's
 * declared `type`, applies JSON Schema fragments (`validation`), and fills in
 * `default` values for missing optional parameters.
 */
import type { WorkflowTemplateDefinition, WorkflowTemplateParameter } from "@delegolabs/types";

export class ParameterValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Parameter validation failed: ${errors.join("; ")}`);
    this.name = "ParameterValidationError";
  }
}

/** Returns a value that matches the given parameter type, or null when it doesn't. */
function coerceOrCheck(value: unknown, type: WorkflowTemplateParameter["type"]): boolean {
  if (value === null || value === undefined) return false;
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && !Array.isArray(value) && value !== null;
    case "array":
      return Array.isArray(value);
    default:
      return false;
  }
}

/**
 * Validates a single parameter value against its type and optional JSON Schema
 * fragment. Returns a list of error strings (empty when valid).
 */
export function validateParameterValue(
  parameter: WorkflowTemplateParameter,
  value: unknown,
): string[] {
  const errors: string[] = [];

  if (!coerceOrCheck(value, parameter.type)) {
    errors.push(`"${parameter.name}" must be of type ${parameter.type}`);
  }

  if (parameter.validation) {
    const schemaErrors = validateAgainstJsonSchema(value, parameter.validation, parameter.name);
    errors.push(...schemaErrors);
  }

  return errors;
}

/**
 * Validates the provided raw values against a template's parameter declarations.
 * Applies defaults for missing optional parameters and returns a fully resolved
 * parameter map plus any validation errors.
 */
export function validateParameters(
  parameters: WorkflowTemplateParameter[],
  rawValues: Record<string, unknown>,
): { valid: boolean; resolved: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  const resolved: Record<string, unknown> = {};

  for (const param of parameters) {
    const present = Object.prototype.hasOwnProperty.call(rawValues, param.name);
    const value = present ? rawValues[param.name] : undefined;

    if (!present || value === undefined || value === null) {
      if (param.required) {
        errors.push(`Missing required parameter "${param.name}"`);
      } else if (param.default !== undefined) {
        resolved[param.name] = param.default;
      }
      continue;
    }

    resolved[param.name] = value;
    errors.push(...validateParameterValue(param, value));
  }

  return { valid: errors.length === 0, resolved, errors };
}

/**
 * Validates a workflow template definition is structurally sound — it must have
 * a non-empty set of states and a non-empty set of transitions.
 */
export function validateTemplateDefinition(
  definition: WorkflowTemplateDefinition,
): string[] {
  const errors: string[] = [];

  if (!definition || typeof definition !== "object") {
    return ["definition is required"];
  }

  if (!definition.states || typeof definition.states !== "object") {
    errors.push("definition.states must be an object");
  } else if (Object.keys(definition.states).length === 0) {
    errors.push("definition.states must contain at least one state");
  }

  if (!Array.isArray(definition.transitions)) {
    errors.push("definition.transitions must be an array");
  } else if (definition.transitions.length === 0) {
    errors.push("definition.transitions must contain at least one transition");
  }

  return errors;
}

/**
 * A small, dependency-free JSON Schema fragment validator covering the subset of
 * JSON Schema keywords that are meaningful for template parameters:
 *   - enum
 *   - minLength / maxLength (strings)
 *   - minimum / maximum (numbers)
 *   - pattern (strings)
 *   - items (arrays)
 *   - properties / required / additionalProperties (objects)
 */
export function validateAgainstJsonSchema(
  value: unknown,
  schemaText: string,
  path = "value",
): string[] {
  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(schemaText);
  } catch {
    return [`"${path}" has an invalid JSON Schema fragment`];
  }

  const errors: string[] = [];
  collectSchemaErrors(value, schema, path, errors);
  return errors;
}

function collectSchemaErrors(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  out: string[],
): void {
  if (schema.enum !== undefined && Array.isArray(schema.enum)) {
    if (!schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
      out.push(`"${path}" must be one of [${schema.enum.map((e) => JSON.stringify(e)).join(", ")}]`);
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      out.push(`"${path}" must be at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      out.push(`"${path}" must be at most ${schema.maxLength} characters`);
    }
    if (typeof schema.pattern === "string") {
      let re: RegExp;
      try {
        re = new RegExp(schema.pattern);
      } catch {
        out.push(`"${path}" has an invalid pattern in schema`);
        re = /(?:)/;
      }
      if (!re.test(value)) {
        out.push(`"${path}" must match pattern ${schema.pattern}`);
      }
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      out.push(`"${path}" must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      out.push(`"${path}" must be <= ${schema.maximum}`);
    }
  }

  if (Array.isArray(value) && typeof schema.items === "object" && schema.items !== null) {
    value.forEach((item, index) => {
      collectSchemaErrors(item, schema.items as Record<string, unknown>, `${path}[${index}]`, out);
    });
  }

  if (value && typeof value === "object" && !Array.isArray(value) && schema.properties !== undefined) {
    const props = schema.properties as Record<string, unknown>;
    for (const [key, propSchemaRaw] of Object.entries(props)) {
      const propSchema =
        typeof propSchemaRaw === "object" && propSchemaRaw !== null
          ? (propSchemaRaw as Record<string, unknown>)
          : {};
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        collectSchemaErrors((value as Record<string, unknown>)[key], propSchema, `${path}.${key}`, out);
      } else if (propSchema.required === true) {
        out.push(`"${path}.${key}" is required`);
      }
    }
    if (
      typeof schema.additionalProperties === "boolean" &&
      schema.additionalProperties === false
    ) {
      const props = schema.properties as Record<string, unknown>;
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (!props || !Object.prototype.hasOwnProperty.call(props, key)) {
          out.push(`"${path}" contains unexpected property "${key}"`);
        }
      }
    }
  }
}
