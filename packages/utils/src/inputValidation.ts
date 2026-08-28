/**
 * Input validation and sanitization (Issue #79).
 *
 * A schema-driven validator for API request bodies/query/params, covering
 * type checking, string sanitization (basic XSS/HTML-entity escaping), and
 * pattern/enum/length constraints. Injection prevention for SQL/NoSQL is
 * primarily an architectural property (parameterized queries via `pg`,
 * never raw string interpolation — already this codebase's convention,
 * see e.g. every `pool.query("...$1...", [args])` call site) rather than
 * something a generic input validator can enforce after the fact; this
 * module focuses on what a validator *can* meaningfully do: reject
 * malformed/oversized/wrong-shaped input and neutralize markup before it
 * reaches a response or a log line.
 */

export type FieldType = "string" | "number" | "boolean" | "date" | "email" | "url" | "uuid" | "custom";

export interface ValidationRule {
  field: string;
  type: FieldType;
  required: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  enum?: unknown[];
  customValidator?: (value: unknown) => boolean;
  sanitizer?: (value: string) => string;
}

export interface ValidationSchema {
  body?: ValidationRule[];
  query?: ValidationRule[];
  params?: ValidationRule[];
  headers?: ValidationRule[];
}

export interface ValidationError {
  field: string;
  rule: string;
  message: string;
  value?: unknown;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  sanitizedData: Record<string, unknown>;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH_TRAVERSAL_PATTERN = /(\.\.[/\\])|(^[/\\])/;

/** Escape the 5 characters that matter for HTML/XSS context. Not a full
 * HTML sanitizer (no allowlist-based tag stripping) — for fields that
 * should contain no markup at all, which is the common case for API JSON
 * fields (names, addresses, notes) rendered back into HTML later. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Reject a path segment containing `..` traversal or a leading
 * slash/backslash (absolute path injection). */
export function isPathTraversalSafe(value: string): boolean {
  return !PATH_TRAVERSAL_PATTERN.test(value);
}

function isValidType(value: unknown, type: FieldType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
    case "email":
      return typeof value === "string" && EMAIL_PATTERN.test(value);
    case "url":
      return typeof value === "string" && isValidUrl(value);
    case "uuid":
      return typeof value === "string" && UUID_PATTERN.test(value);
    case "custom":
      return true; // delegated entirely to customValidator
  }
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function validateField(
  rule: ValidationRule,
  value: unknown,
): { errors: ValidationError[]; sanitizedValue: unknown } {
  const errors: ValidationError[] = [];

  if (value === undefined || value === null || value === "") {
    if (rule.required) {
      errors.push({ field: rule.field, rule: "required", message: `${rule.field} is required` });
    }
    return { errors, sanitizedValue: value };
  }

  if (!isValidType(value, rule.type)) {
    errors.push({
      field: rule.field,
      rule: "type",
      message: `${rule.field} must be of type ${rule.type}`,
      value,
    });
    return { errors, sanitizedValue: value };
  }

  if (rule.customValidator && !rule.customValidator(value)) {
    errors.push({ field: rule.field, rule: "custom", message: `${rule.field} failed custom validation`, value });
  }

  if (typeof value === "string") {
    if (rule.minLength !== undefined && value.length < rule.minLength) {
      errors.push({
        field: rule.field,
        rule: "minLength",
        message: `${rule.field} must be at least ${rule.minLength} characters`,
        value,
      });
    }
    if (rule.maxLength !== undefined && value.length > rule.maxLength) {
      errors.push({
        field: rule.field,
        rule: "maxLength",
        message: `${rule.field} must be at most ${rule.maxLength} characters`,
        value,
      });
    }
    if (rule.pattern !== undefined && !new RegExp(rule.pattern).test(value)) {
      errors.push({
        field: rule.field,
        rule: "pattern",
        message: `${rule.field} does not match the required pattern`,
        value,
      });
    }
  }

  if (rule.enum !== undefined && !rule.enum.includes(value)) {
    errors.push({
      field: rule.field,
      rule: "enum",
      message: `${rule.field} must be one of: ${rule.enum.join(", ")}`,
      value,
    });
  }

  let sanitizedValue = value;
  if (typeof value === "string" && rule.sanitizer) {
    sanitizedValue = rule.sanitizer(value);
  }

  return { errors, sanitizedValue };
}

/** Validate `data` against a list of rules (one section of a
 * ValidationSchema, e.g. just `body` or just `query`). */
export function validateSection(
  rules: ValidationRule[],
  data: Record<string, unknown>,
): ValidationResult {
  const errors: ValidationError[] = [];
  const sanitizedData: Record<string, unknown> = {};

  for (const rule of rules) {
    const { errors: fieldErrors, sanitizedValue } = validateField(rule, data[rule.field]);
    errors.push(...fieldErrors);
    if (data[rule.field] !== undefined) {
      sanitizedData[rule.field] = sanitizedValue;
    }
  }

  return { valid: errors.length === 0, errors, sanitizedData };
}

/** Validate an entire request-shaped payload against a full schema
 * (body/query/params/headers), merging results from each section. */
export function validateRequest(
  schema: ValidationSchema,
  request: { body?: Record<string, unknown>; query?: Record<string, unknown>; params?: Record<string, unknown>; headers?: Record<string, unknown> },
): ValidationResult {
  const sections: Array<[ValidationRule[] | undefined, Record<string, unknown> | undefined]> = [
    [schema.body, request.body],
    [schema.query, request.query],
    [schema.params, request.params],
    [schema.headers, request.headers],
  ];

  const errors: ValidationError[] = [];
  const sanitizedData: Record<string, unknown> = {};

  for (const [rules, data] of sections) {
    if (!rules) continue;
    const result = validateSection(rules, data ?? {});
    errors.push(...result.errors);
    Object.assign(sanitizedData, result.sanitizedData);
  }

  return { valid: errors.length === 0, errors, sanitizedData };
}
