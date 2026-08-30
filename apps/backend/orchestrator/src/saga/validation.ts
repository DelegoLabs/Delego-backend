/**
 * Issue #48 — JSONB saga context schema validation.
 *
 * A small, dependency-free validator (a subset of JSON Schema draft-07) used to validate the
 * `context` column before it is persisted as JSONB. Keeping it in-repo avoids pulling a schema
 * validator dependency into the orchestrator and covers exactly the keywords sagas need:
 * `type`, `required`, `properties` (with `type` / `enum`), `additionalProperties`, and `nullable`.
 */

export type JsonSchemaType =
  | "object"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "null";

export interface JsonSchema {
  type?: JsonSchemaType;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
  enum?: unknown[];
  nullable?: boolean;
  items?: JsonSchema;
}

export class SagaContextValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Saga context failed schema validation: ${errors.join("; ")}`);
    this.name = "SagaContextValidationError";
  }
}

function isInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value);
}

function matchesType(value: unknown, type: JsonSchemaType): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && !Number.isNaN(value);
    case "integer":
      return isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function validateValue(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  if (schema.nullable && value === null) return;

  if (schema.enum !== undefined) {
    if (!schema.enum.includes(value)) {
      errors.push(`${path} must be one of ${JSON.stringify(schema.enum)}`);
    }
    return;
  }

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    errors.push(`${path} must be of type ${schema.type}`);
    return;
  }

  if (schema.type === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) {
        errors.push(`${path}.${key} is required`);
      }
    }
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          validateValue(obj[key], propSchema, `${path}.${key}`, errors);
        }
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
          errors.push(`${path}.${key} is not an allowed property`);
        }
      }
    }
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    const itemsSchema = schema.items;
    value.forEach((item, index) => validateValue(item, itemsSchema, `${path}[${index}]`, errors));
  }

}

/** Validates `context` against `schema`, throwing {@link SagaContextValidationError} on failure. */
export function validateSagaContext(context: unknown, schema?: JsonSchema): void {
  if (context === null || typeof context !== "object" || Array.isArray(context)) {
    throw new SagaContextValidationError(["context must be a JSON object"]);
  }
  if (!schema) return;
  const errors: string[] = [];
  validateValue(context, schema, "context", errors);
  if (errors.length > 0) {
    throw new SagaContextValidationError(errors);
  }
}
