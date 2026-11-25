/*
 * Universal PII masking transform (#355).
 *
 * Customer physical addresses, recipient phone numbers, full credit card /
 * bank identifiers, and Stellar secret keys were being logged in cleartext
 * inside Winston-style structured log entries and OpenTelemetry trace span
 * attributes, violating GDPR/CCPA. This module provides a single,
 * content-pattern-based redaction transform that `createLogger` (logger.ts)
 * and the OTLP span exporter (telemetry/exporter.ts) both apply before a
 * log line or span is emitted/published.
 */

export interface PiiMaskConfig {
  whitelistFields: string[];
  piiFieldPatterns: RegExp[];
  preserveLength?: boolean;
  maskCharacter?: string;
}

export interface MaskResult<T> {
  maskedData: T;
  fieldsRedactedCount: number;
  containsSensitiveData: boolean;
}

/**
 * Returns true if a 13-16 digit card-like number passes the Luhn checksum.
 * This is what distinguishes a real payment card from an arbitrary digit
 * substring inside a non-PII identifier.
 */
function passesLuhn(digits: string): boolean {
  if (!digits || /\D/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Matches 13-16 digit card-like runs, but only redacts those that pass the
 * Luhn checksum. Delimiters between digit groups are allowed only when the
 * groups are consistently spaced / dashed, so raw 6-digit substrings inside
 * alphanumeric identifiers (e.g. "abc123") are never treated as cards.
 */
function maskCreditCards(content: string): string {
  const candidate = /(?<!\w)\d{12,19}(?:[ -]?\d){0,3}(?!\w)/g;
  return content.replace(candidate, (match) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return match;
    if (!passesLuhn(digits)) return match;
    return PII_REDACTION_PLACEHOLDER;
  });
}

/**
 * Strict SNS / tax-ID format: 3/2/4 digits separated by dashes or spaces
 * (e.g. 123-45-6789 or 123 45 6789). Raw 6-digit runs are not considered SNS.
 */
const SNS_PATTERN = /(?<!\d)\d{3}[ -]\d{2}[ -]\d{4}(?!\d)/g;

export const PII_PATTERNS = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  // Anchored to token boundaries: without them this also matched the digits
  // inside identifiers such as "abc123" or "user_42", redacting non-PII.
  phone: /(?<!\w)\+?[1-9]\d{1,14}(?!\w)/g,
  // Strict SNS / tax ID format requiring delimiter spacing.
  ssn: SNS_PATTERN,
  // Stellar secret seeds: "S" followed by 55 base32 chars (56 chars total).
  stellarSecret: /S[A-Z0-9]{55}/g,
} as const;

/**
 * Order matters: more specific / higher-signal patterns run first so that,
 * e.g., a Stellar secret or credit card number isn't partially consumed by
 * the much broader `phone` pattern before it gets a chance to match. Each
 * regex is applied with the global flag, and `String.prototype.replace` resets `lastIndex` to 0 for a global pattern before iterating, so reusing the
 * shared regex objects across calls is safe.
 */
const PATTERN_ORDER: Array<keyof typeof PII_PATTERNS> = [
  "stellarSecret",
  "ssn",
  "email",
  "phone",
];

export const PII_REDACTION_PLACEHOLDER = "[REDACTED]";

/**
 * Identifier shapes that carry no PII but contain digit groups which the
 * broader patterns below would match: a UUID such as
 * `c601569c-cb5d-4251-8f90-9f7782375020` has its `4251` group matched by
 * `phone`, which manges request ids / trace ids and breaks correlation
 * between a log line and the request it describes. Such values are held
 * aside while the patterns run and restored verbatim afterwards.
 */
const NON_PII_IDENTIFIER_PATTERN =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

const IDENTIFIER_PLACEHOLDER_PATTERN = /\u0000(\d+)\u0000/g;

/**
 * Replace any PII tokens (emails, phone numbers, credit card / bank
 * identifiers, Stellar secret keys) found in `content` with a redaction
 * placeholder. Non-string input is returned unchanged.
 */
export function maskPii(content: string): string {
  if (typeof content !== "string" || content.length === 0) {
    return content;
  }

  const identifiers: string[] = [];
  let masked = content.replace(NON_PII_IDENTIFIER_PATTERN, (identifier) => {
    identifiers.push(identifier);
    return `\u0000${identifiers.length - 1}\u0000`;
  });

  // Card numbers require a Luhn checksum, so they are handled separately
  // from the plain regex patterns.
  masked = maskCreditCards(masked);

  for (const key of PATTERN_ORDER) {
    masked = masked.replace(PII_PATTERNS[key], PII_REDACTION_PLACEHOLDER);
  }

  return masked.replace(IDENTIFIER_PLACEHOLDER_PATTERN, (_match, index: string) =>
    identifiers[Number(index)],
  );
}

/**
 * Field keys that hold non-PII identifiers (user ids, order ids, transaction
 * hashes, request ids, ...) and must never be subjected to content
 * redaction. Matching is case-insensitive and tolerates common separators
 * (`user_id`, `user-id`, `userId`).
 */
const WHITELISTED_FIELD_PATTERNS: RegExp[] = [
  /^id$/i,
  /^(user|order|tx|transaction)(?:[+-_]?id)$/i,
  /^(?:tx|transaction|block|ledger|request|trace|span)(?:[+-_]?(?:hash))?$/i,
  /^hash$/i,
];

function isWhitelistedField(key: string): boolean {
  return WHITELISTED_FIELD_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Recursively walk an arbitrary value (log metadata, span attribute maps,
 * etc.) and run {@link maskPii} over every string it contains. Numbers,
 * booleans, null/undefined pass through untouched; arrays and plain objects
 * are walked depth-first. Field keys matching {@link WHITELISTED_FIELD_PATTERNS}
 * are preserved verbatim, including any nested values.
 */
export function maskPiiDeep<T>(value: T, config?: PiiMaskConfig): T {
  if (typeof value === "string") {
    return maskPii(value) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => maskPiiDeep(item, config)) as unknown as T;
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const whitelisted =
        isWhitelistedField(key) ||
        Boolean(config?.whitelistFields?.includes(key));
      result[key] = whitelisted ? val : maskPiiDeep(val, config);
    }
    return result as T;
  }

  return value;
}

/** Returns true if `content` contains any recognizable PII token. */
export function containsPii(content: string): boolean {
  if (typeof content !== "string" || content.length === 0) {
    return false;
  }
  // `.test()` on a shared global-flag regex mutates its `lastIndex`, which
  // would corrupt later calls — reset it explicitly rather than relying on
  // engine-specific reuse behavior.
  return PATTERN_ORDER.some((key) => {
    const pattern = PII_PATTERNS[key];
    pattern.lastIndex = 0;
    return pattern.test(content);
  });
}
