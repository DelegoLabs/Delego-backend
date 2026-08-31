/**
 * OpenAPI request/response validation engine (Issue #52).
 *
 * Compiles the gateway's OpenAPI spec (src/openapi.ts, or an external JSON
 * file when GATEWAY_OPENAPI_SPEC_PATH is set) into matchable operations and
 * validates inbound requests / outbound responses against them using AJV.
 *
 * This module is framework-agnostic (no res/req wiring) — see
 * ../middleware/openApiValidation.ts for the middleware that plugs this into
 * the gateway's request pipeline.
 */

import { readFileSync, watch, type FSWatcher } from "node:fs";
import Ajv, { type ValidateFunction, type ErrorObject } from "ajv";
import addFormats from "ajv-formats";

// ajv's default export is a namespace/value, not a usable type in this
// project's TS config — mirror the `(Ajv as any)` pattern already used in
// src/validation.ts and type the instance as `any` at the boundary.
type AjvInstance = any;
import { createLogger } from "@delegolabs/utils";
import { openApiSpec as builtInOpenApiSpec } from "./openapi.js";

const log = createLogger("gateway:openapi-validation");

// ─── Public types (per Issue #52) ──────────────────────────────────────────

export interface ValidationConfig {
  enabled: boolean;
  validateRequests: boolean;
  validateResponses: boolean;
  /** Reject unknown/undeclared properties on object schemas. */
  strictMode: boolean;
  /**
   * Named custom validators. Referenced from a schema via a matching boolean
   * keyword, e.g. `{ "type": "string", "isStellarAddress": true }` invokes
   * the function registered under the key "isStellarAddress".
   */
  customValidators: Map<string, (value: unknown) => boolean>;
  /** Path prefixes to skip entirely (e.g. health checks). */
  skipPaths: string[];
}

export type ValidationErrorCode = "required" | "type" | "format" | "enum" | "custom";

export interface ValidationError {
  field: string;
  message: string;
  code: ValidationErrorCode;
  value?: unknown;
  path: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  sanitizedData?: Record<string, unknown>;
}

export const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  enabled: true,
  validateRequests: true,
  validateResponses: false,
  strictMode: false,
  customValidators: new Map(),
  skipPaths: ["/health"],
};

// ─── Spec compilation (path templates → matchers) ──────────────────────────

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head"] as const;

interface CompiledOperation {
  method: string;
  pathTemplate: string;
  pattern: RegExp;
  paramNames: string[];
  operation: Record<string, any>;
}

export interface ResolvedOperation {
  operation: Record<string, any>;
  pathTemplate: string;
  pathParams: Record<string, string>;
}

/** Turns an OpenAPI path template ("/api/v1/wallets/{id}") into a regex + param name list. */
export function compilePathTemplate(pathTemplate: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const segments = pathTemplate.split(/(\{[^}]+\})/g);
  const regexSource = segments
    .map((segment) => {
      const match = segment.match(/^\{([^}]+)\}$/);
      if (match) {
        paramNames.push(match[1]);
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return { pattern: new RegExp(`^${regexSource}$`), paramNames };
}

function compileOperations(spec: Record<string, any>): CompiledOperation[] {
  const compiled: CompiledOperation[] = [];
  const paths = spec?.paths ?? {};
  for (const [pathTemplate, pathItem] of Object.entries<Record<string, any>>(paths)) {
    const { pattern, paramNames } = compilePathTemplate(pathTemplate);
    for (const method of HTTP_METHODS) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      compiled.push({ method: method.toUpperCase(), pathTemplate, pattern, paramNames, operation });
    }
  }
  return compiled;
}

export function resolveOperation(
  compiledOperations: CompiledOperation[],
  method: string,
  pathname: string
): ResolvedOperation | null {
  for (const entry of compiledOperations) {
    if (entry.method !== method) continue;
    const match = pathname.match(entry.pattern);
    if (!match) continue;
    const pathParams: Record<string, string> = {};
    entry.paramNames.forEach((name, i) => {
      pathParams[name] = decodeURIComponent(match[i + 1] ?? "");
    });
    return { operation: entry.operation, pathTemplate: entry.pathTemplate, pathParams };
  }
  return null;
}

// ─── AJV wiring ─────────────────────────────────────────────────────────────

function createAjv(config: ValidationConfig): AjvInstance {
  const ajv = new (Ajv as any)({ allErrors: true, coerceTypes: true, strict: false });
  (addFormats as any)(ajv);

  for (const [name, validatorFn] of config.customValidators) {
    ajv.addKeyword({
      keyword: name,
      validate: (schemaValue: unknown, data: unknown) => {
        if (!schemaValue) return true;
        try {
          return validatorFn(data);
        } catch (err) {
          log.warn("Custom validator threw; treating value as invalid", { validator: name, error: String(err) });
          return false;
        }
      },
      errors: false,
    });
  }

  return ajv;
}

/** Recursively sets additionalProperties: false on object schemas that don't already declare it. */
function applyStrictMode(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(applyStrictMode);

  const clone: Record<string, any> = { ...(schema as Record<string, any>) };
  if (clone.type === "object" && clone.properties && clone.additionalProperties === undefined) {
    clone.additionalProperties = false;
  }
  if (clone.properties) {
    clone.properties = Object.fromEntries(
      Object.entries(clone.properties).map(([key, value]) => [key, applyStrictMode(value)])
    );
  }
  if (clone.items) clone.items = applyStrictMode(clone.items);
  return clone;
}

function mapErrorCode(keyword: string): ValidationErrorCode {
  switch (keyword) {
    case "required":
      return "required";
    case "type":
      return "type";
    case "format":
    case "pattern":
      return "format";
    case "enum":
      return "enum";
    default:
      return "custom";
  }
}

function mapAjvErrors(ajvErrors: ErrorObject[] | null | undefined, root: string): ValidationError[] {
  return (ajvErrors ?? []).map((err) => {
    const instancePath = err.instancePath ? err.instancePath.slice(1).split("/") : [];
    const missingProperty = err.keyword === "required" ? (err.params as any)?.missingProperty : undefined;
    const path = missingProperty ? [...instancePath, missingProperty] : instancePath;
    const field = [root, ...path].filter(Boolean).join(".") || root;
    return {
      field,
      message: err.message ?? "Invalid value",
      code: mapErrorCode(err.keyword),
      value: err.data,
      path: [root, ...path],
    };
  });
}

function buildParamsSchema(parameters: any[] | undefined, location: "query" | "header" | "path"): Record<string, any> {
  const relevant = (parameters ?? []).filter((p) => p.in === location);
  const properties: Record<string, any> = {};
  const required: string[] = [];
  for (const param of relevant) {
    properties[param.name] = param.schema ?? { type: "string" };
    if (param.required) required.push(param.name);
  }
  return { type: "object", properties, required, additionalProperties: true };
}

// ─── Engine ─────────────────────────────────────────────────────────────────

export interface RequestValidationInput {
  method: string;
  pathParams: Record<string, string>;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  hasBody: boolean;
}

/**
 * Compiles an OpenAPI spec once and serves cached AJV validators for the
 * operations within it. Optionally hot-reloads from an external JSON file.
 */
export class OpenApiValidationEngine {
  private readonly config: ValidationConfig;
  private readonly ajv: AjvInstance;
  private readonly specPath?: string;
  private compiledOperations: CompiledOperation[];
  private requestValidatorCache = new WeakMap<object, ValidateFunction>();
  private responseValidatorCache = new WeakMap<object, ValidateFunction>();
  private watcher?: FSWatcher;

  constructor(config: Partial<ValidationConfig> = {}, specPath?: string) {
    this.config = { ...DEFAULT_VALIDATION_CONFIG, ...config };
    this.ajv = createAjv(this.config);
    this.specPath = specPath;
    this.compiledOperations = compileOperations(this.loadSpec());
    this.watchSpec();
  }

  private loadSpec(): Record<string, any> {
    if (this.specPath) {
      try {
        const raw = readFileSync(this.specPath, "utf8");
        return JSON.parse(raw);
      } catch (err) {
        log.error("Failed to load external OpenAPI spec; falling back to built-in spec", {
          path: this.specPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return builtInOpenApiSpec as unknown as Record<string, any>;
  }

  private watchSpec(): void {
    if (!this.specPath) return;
    try {
      this.watcher = watch(this.specPath, { persistent: false }, () => {
        try {
          this.compiledOperations = compileOperations(this.loadSpec());
          this.requestValidatorCache = new WeakMap();
          this.responseValidatorCache = new WeakMap();
          log.info("OpenAPI spec hot-reloaded", { path: this.specPath });
        } catch (err) {
          log.error("Failed to hot-reload OpenAPI spec; keeping previous version", {
            path: this.specPath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    } catch (err) {
      log.warn("Could not watch OpenAPI spec file for hot-reload", {
        path: this.specPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Stops the file watcher, if any. Call on graceful shutdown / in tests. */
  close(): void {
    this.watcher?.close();
  }

  resolve(method: string, pathname: string): ResolvedOperation | null {
    return resolveOperation(this.compiledOperations, method, pathname);
  }

  private getCompiled(schema: Record<string, any>, cache: WeakMap<object, ValidateFunction>): ValidateFunction {
    const cached = cache.get(schema);
    if (cached) return cached;
    const effectiveSchema = this.config.strictMode ? (applyStrictMode(schema) as Record<string, any>) : schema;
    const validate = this.ajv.compile(effectiveSchema);
    cache.set(schema, validate);
    return validate;
  }

  validateRequest(operation: Record<string, any>, input: RequestValidationInput): ValidationResult {
    const errors: ValidationError[] = [];
    const sanitizedData: Record<string, unknown> = {};
    const parameters: any[] = operation.parameters ?? [];

    // Path params
    if (parameters.some((p) => p.in === "path")) {
      const schema = buildParamsSchema(parameters, "path");
      const validate = this.getCompiled(schema, this.requestValidatorCache);
      const data = { ...input.pathParams };
      if (!validate(data)) {
        errors.push(...mapAjvErrors(validate.errors, "path"));
      } else {
        sanitizedData.path = data;
      }
    }

    // Query params
    if (parameters.some((p) => p.in === "query")) {
      const schema = buildParamsSchema(parameters, "query");
      const validate = this.getCompiled(schema, this.requestValidatorCache);
      const data: Record<string, unknown> = {};
      for (const key of input.query.keys()) {
        data[key] = input.query.get(key);
      }
      if (!validate(data)) {
        errors.push(...mapAjvErrors(validate.errors, "query"));
      } else {
        sanitizedData.query = data;
      }
    }

    // Headers
    if (parameters.some((p) => p.in === "header")) {
      const schema = buildParamsSchema(parameters, "header");
      const validate = this.getCompiled(schema, this.requestValidatorCache);
      const data: Record<string, unknown> = {};
      for (const param of parameters.filter((p) => p.in === "header")) {
        const raw = input.headers[param.name.toLowerCase()];
        data[param.name] = Array.isArray(raw) ? raw[0] : raw;
      }
      if (!validate(data)) {
        errors.push(...mapAjvErrors(validate.errors, "headers"));
      } else {
        sanitizedData.headers = data;
      }
    }

    // Body
    const bodySchema = operation.requestBody?.content?.["application/json"]?.schema;
    if (bodySchema) {
      if (!input.hasBody) {
        if (operation.requestBody.required) {
          errors.push({ field: "body", message: "Request body is required", code: "required", path: ["body"] });
        }
      } else {
        const validate = this.getCompiled(bodySchema, this.requestValidatorCache);
        if (!validate(input.body)) {
          errors.push(...mapAjvErrors(validate.errors, "body"));
        } else {
          sanitizedData.body = input.body;
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      sanitizedData: Object.keys(sanitizedData).length > 0 ? sanitizedData : undefined,
    };
  }

  validateResponse(operation: Record<string, any>, statusCode: number, body: unknown): ValidationResult {
    const responseSpec = operation.responses?.[String(statusCode)] ?? operation.responses?.default;
    const schema = responseSpec?.content?.["application/json"]?.schema;
    if (!schema) return { valid: true, errors: [] };

    const validate = this.getCompiled(schema, this.responseValidatorCache);
    if (validate(body)) return { valid: true, errors: [] };
    return { valid: false, errors: mapAjvErrors(validate.errors, "response") };
  }
}
