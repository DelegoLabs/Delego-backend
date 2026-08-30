/**
 * PII field detection and masking utility
 * Issue #151
 */

import type { LoggingConfig } from "@delegolabs/types";

const DEFAULT_PII_FIELDS = [
  "password",
  "passwordHash",
  "token",
  "accessToken",
  "refreshToken",
  "secret",
  "apiKey",
  "authorization",
  "creditCard",
  "ssn",
  "socialSecurityNumber",
  "bankAccount",
  "routingNumber",
  "email",
  "phone",
  "address",
  "ipAddress",
  "privateKey",
  "secretKey",
  "accessKey",
];

const DEFAULT_MASKING_RULES: Array<{ pattern: string; replacement: string }> = [
  { pattern: "\\b\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}\\b", replacement: "****-****-****-****" },
  { pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b", replacement: "***-**-****" },
  { pattern: "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b", replacement: "[EMAIL_MASKED]" },
  { pattern: "\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b", replacement: "[IP_MASKED]" },
  { pattern: "Bearer\\s+[A-Za-z0-9\\-._~+/]+=*", replacement: "Bearer [TOKEN_MASKED]" },
];

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "proxy-authorization",
]);

function compilePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "gi");
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  }
}

function isPiiField(fieldName: string, piiFields: string[]): boolean {
  const lower = fieldName.toLowerCase();
  return piiFields.some(
    (f) => lower.includes(f.toLowerCase()) || lower === f.toLowerCase()
  );
}

function maskValue(value: unknown, rules: Array<{ pattern: string; replacement: string }>): unknown {
  if (typeof value !== "string") return value;
  let masked = value;
  for (const rule of rules) {
    const regex = compilePattern(rule.pattern);
    masked = masked.replace(regex, rule.replacement);
  }
  return masked;
}

function maskObject(
  obj: Record<string, unknown>,
  config: LoggingConfig
): { masked: Record<string, unknown>; fieldsMasked: string[] } {
  const masked: Record<string, unknown> = {};
  const fieldsMasked: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      masked[key] = "[MASKED]";
      fieldsMasked.push(key);
    } else if (isPiiField(key, config.piiFields)) {
      if (typeof value === "object" && value !== null) {
        const result = maskObject(value as Record<string, unknown>, config);
        masked[key] = result.masked;
        fieldsMasked.push(...result.fieldsMasked.map((f) => `${key}.${f}`));
      } else {
        masked[key] = "[MASKED]";
        fieldsMasked.push(key);
      }
    } else if (typeof value === "object" && value !== null) {
      if (Array.isArray(value)) {
        const result: unknown[] = [];
        value.forEach((item, idx) => {
          if (typeof item === "object" && item !== null) {
            const maskedItem = maskObject(item as Record<string, unknown>, config);
            result.push(maskedItem.masked);
            fieldsMasked.push(...maskedItem.fieldsMasked.map((f) => `${key}[${idx}].${f}`));
          } else {
            result.push(maskValue(item, config.maskingRules));
          }
        });
        masked[key] = result;
      } else {
        const result = maskObject(value as Record<string, unknown>, config);
        masked[key] = result.masked;
        fieldsMasked.push(...result.fieldsMasked.map((f) => `${key}.${f}`));
      }
    } else {
      const maskedValue = maskValue(value, config.maskingRules);
      if (maskedValue !== value) {
        fieldsMasked.push(key);
      }
      masked[key] = maskedValue;
    }
  }

  return { masked, fieldsMasked };
}

export function maskPiiData(
  data: Record<string, unknown>,
  config?: Partial<LoggingConfig>
): { masked: Record<string, unknown>; fieldsMasked: string[] } {
  const fullConfig: LoggingConfig = {
    enabled: true,
    sampleRate: 1,
    piiFields: DEFAULT_PII_FIELDS,
    maskingRules: DEFAULT_MASKING_RULES,
    sensitiveEndpoints: [],
    retentionDays: 30,
    ...config,
  };

  return maskObject(data, fullConfig);
}

export function maskHeaders(
  headers: Record<string, string>,
  config?: Partial<LoggingConfig>
): { masked: Record<string, string>; fieldsMasked: string[] } {
  const fullConfig: LoggingConfig = {
    enabled: true,
    sampleRate: 1,
    piiFields: DEFAULT_PII_FIELDS,
    maskingRules: DEFAULT_MASKING_RULES,
    sensitiveEndpoints: [],
    retentionDays: 30,
    ...config,
  };

  const masked: Record<string, string> = {};
  const fieldsMasked: string[] = [];

  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      masked[key] = "[MASKED]";
      fieldsMasked.push(key);
    } else if (isPiiField(key, fullConfig.piiFields)) {
      masked[key] = "[MASKED]";
      fieldsMasked.push(key);
    } else {
      masked[key] = maskValue(value, fullConfig.maskingRules) as string;
    }
  }

  return { masked, fieldsMasked };
}

export function isSensitiveEndpoint(path: string, endpoints: string[]): boolean {
  return endpoints.some((ep) => path.startsWith(ep) || path.includes(ep));
}

export function shouldSample(sampleRate: number): boolean {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  return Math.random() < sampleRate;
}
