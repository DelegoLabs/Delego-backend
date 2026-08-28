// Issue #116 — Translation validation. Validates ICU syntax, placeholder
// consistency between a translation and its declared template placeholders,
// and required-placeholder coverage.

import type {
  LocalizedTemplate,
  ValidationResult,
  ValidationIssue,
} from "./types.js";
import { parseIcuMessage, IcuSyntaxError, extractIcuArguments, normalizeLegacyPlaceholders } from "./icu.js";

/** Validate that `message` is well-formed ICU. Returns error strings (empty = valid). */
export function validateIcuSyntax(message: string): string[] {
  try {
    parseIcuMessage(normalizeLegacyPlaceholders(message));
    return [];
  } catch (err) {
    return [err instanceof IcuSyntaxError ? err.message : String(err)];
  }
}

/** Placeholders used by a translation string (best-effort on malformed ICU). */
export function translationArguments(
  subject: string,
  html: string,
  text: string
): Set<string> {
  const args = new Set<string>();
  for (const part of [subject, html, text]) {
    try {
      for (const arg of extractIcuArguments(normalizeLegacyPlaceholders(part))) {
        args.add(arg);
      }
    } catch {
      // Malformed ICU is reported separately by validateIcuSyntax; skip here.
    }
  }
  return args;
}

/**
 * Validate a single locale's translation of a template.
 *
 * The template's `defaultLocale` translation defines the authoritative
 * placeholder set; every locale must use a subset of those placeholders and
 * must keep the `required` ones. Placeholders declared but unused produce
 * warnings rather than errors (they may be intentionally absent in some
 * dialects).
 */
export function validateTemplateTranslation(
  template: LocalizedTemplate,
  locale: string
): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: string[] = [];
  const translation = template.translations[locale];

  if (!translation) {
    return {
      locale,
      valid: false,
      errors: [{ field: "translations", message: `no translation for locale "${locale}"` }],
      warnings: [],
    };
  }

  const fields: Array<[string, string]> = [
    ["subject", translation.subject],
    ["html", translation.html],
    ["text", translation.text],
  ];

  // 1. ICU syntax.
  for (const [field, value] of fields) {
    const syntaxErrors = validateIcuSyntax(value);
    for (const message of syntaxErrors) {
      errors.push({ field, message });
    }
  }

  const defaultTranslation = template.translations[template.defaultLocale];
  const declared = new Map<string, boolean>();
  if (defaultTranslation) {
    for (const placeholder of defaultTranslation.placeholders) {
      declared.set(placeholder.name, placeholder.required);
    }
  }

  const used = translationArguments(
    translation.subject,
    translation.html,
    translation.text
  );

  // 2. Every used placeholder must be declared.
  for (const name of used) {
    if (!declared.has(name)) {
      errors.push({
        field: "placeholders",
        message: `placeholder "${name}" is used but not declared`,
        placeholder: name,
      });
    }
  }

  // 3. Required placeholders must be present.
  for (const [name, required] of declared) {
    if (required && !used.has(name)) {
      errors.push({
        field: "placeholders",
        message: `required placeholder "${name}" is missing`,
        placeholder: name,
      });
    }
  }

  // 4. Declared-but-unused placeholders are warnings.
  for (const [name] of declared) {
    if (!used.has(name)) {
      warnings.push(`placeholder "${name}" is declared but never used`);
    }
  }

  return { locale, valid: errors.length === 0, errors, warnings };
}

/** Validate every bundled translation of a template. */
export function validateTemplate(template: LocalizedTemplate): ValidationResult[] {
  const results: ValidationResult[] = [];
  const locales = new Set([
    template.defaultLocale,
    ...Object.keys(template.translations),
  ]);
  for (const locale of locales) {
    results.push(validateTemplateTranslation(template, locale));
  }
  return results;
}

/** True if a template's translations are all valid. */
export function isTemplateValid(template: LocalizedTemplate): boolean {
  return validateTemplate(template).every((r) => r.valid);
}
