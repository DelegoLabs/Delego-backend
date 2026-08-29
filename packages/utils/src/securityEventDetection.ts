/**
 * Heuristic detection of common injection-attack payload patterns
 * (Issue #79), for logging/alerting purposes.
 *
 * This is a detector, not a filter: it flags suspicious input for
 * security-event logging (SecurityEvent) even when validateRequest's
 * schema-based checks already reject the field for an unrelated reason
 * (wrong type, too long) — so an attempted attack is visible in
 * monitoring even if it never reached anything exploitable.
 */

export type SecurityEventType =
  | "xss_attempt"
  | "sql_injection"
  | "path_traversal"
  | "command_injection"
  | "file_upload";

export type SecurityEventSeverity = "low" | "medium" | "high" | "critical";

export interface SecurityEvent {
  type: SecurityEventType;
  severity: SecurityEventSeverity;
  sourceIp: string;
  endpoint: string;
  payload: string;
  blocked: boolean;
  timestamp: string;
}

const XSS_PATTERNS = [/<script\b/i, /on\w+\s*=\s*["']/i, /javascript:/i, /<iframe\b/i];
const SQL_INJECTION_PATTERNS = [
  /(\bunion\b.*\bselect\b)/i,
  /(\bor\b\s+['"]?\d+['"]?\s*=\s*['"]?\d+['"]?)/i,
  /(;\s*drop\s+table)/i,
  /(--|\#)\s*$/,
];
const COMMAND_INJECTION_PATTERNS = [/[;&|`$]/, /\$\(.*\)/];

/**
 * Scan `value` for known attack-payload patterns and return the matching
 * event types (a single value can match more than one category — e.g. a
 * payload containing both `<script>` and `; rm -rf`). Returns an empty
 * array for benign input.
 */
export function detectSuspiciousPatterns(value: string): SecurityEventType[] {
  const matches: SecurityEventType[] = [];

  if (XSS_PATTERNS.some((p) => p.test(value))) {
    matches.push("xss_attempt");
  }
  if (SQL_INJECTION_PATTERNS.some((p) => p.test(value))) {
    matches.push("sql_injection");
  }
  if (!isPathTraversalSafeValue(value)) {
    matches.push("path_traversal");
  }
  if (COMMAND_INJECTION_PATTERNS.some((p) => p.test(value))) {
    matches.push("command_injection");
  }

  return matches;
}

function isPathTraversalSafeValue(value: string): boolean {
  return !/(\.\.[/\\])|(^[/\\])/.test(value);
}

const SEVERITY_BY_TYPE: Record<SecurityEventType, SecurityEventSeverity> = {
  sql_injection: "critical",
  command_injection: "critical",
  path_traversal: "high",
  xss_attempt: "medium",
  file_upload: "medium",
};

/** Build SecurityEvent records for every pattern detected in `value`. */
export function buildSecurityEvents(
  value: string,
  context: { sourceIp: string; endpoint: string; blocked: boolean },
  now: () => string = () => new Date().toISOString(),
): SecurityEvent[] {
  return detectSuspiciousPatterns(value).map((type) => ({
    type,
    severity: SEVERITY_BY_TYPE[type],
    sourceIp: context.sourceIp,
    endpoint: context.endpoint,
    payload: value,
    blocked: context.blocked,
    timestamp: now(),
  }));
}

const ALLOWED_UPLOAD_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "pdf", "csv", "txt"]);
const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export interface FileUploadValidationInput {
  filename: string;
  sizeBytes: number;
  declaredMimeType: string;
  /** First few bytes of the file, for a minimal magic-number check. */
  headerBytes?: Uint8Array;
}

const MAGIC_NUMBERS: Array<{ mime: string; bytes: number[] }> = [
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
];

/** Validate a file upload's extension, size, and (when header bytes are
 * available) that its declared MIME type matches its actual magic number —
 * catching a renamed executable masquerading as an image, for example. */
export function validateFileUpload(input: FileUploadValidationInput): ValidationErrorList {
  const errors: string[] = [];

  const extension = input.filename.split(".").pop()?.toLowerCase();
  if (!extension || !ALLOWED_UPLOAD_EXTENSIONS.has(extension)) {
    errors.push(`File extension ".${extension ?? ""}" is not allowed`);
  }

  if (input.sizeBytes > MAX_UPLOAD_SIZE_BYTES) {
    errors.push(`File exceeds maximum size of ${MAX_UPLOAD_SIZE_BYTES} bytes`);
  }
  if (input.sizeBytes <= 0) {
    errors.push("File is empty");
  }

  if (input.headerBytes) {
    const expected = MAGIC_NUMBERS.find((m) => m.mime === input.declaredMimeType);
    if (expected && !matchesMagicNumber(input.headerBytes, expected.bytes)) {
      errors.push(`File content does not match declared type "${input.declaredMimeType}"`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export interface ValidationErrorList {
  valid: boolean;
  errors: string[];
}

function matchesMagicNumber(header: Uint8Array, expected: number[]): boolean {
  if (header.length < expected.length) return false;
  return expected.every((byte, i) => header[i] === byte);
}
