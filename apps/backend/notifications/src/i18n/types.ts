// Issue #116 — Core data types for the template localization system.

/** A single declared placeholder within a localized template translation. */
export interface LocalizedTemplatePlaceholder {
  name: string;
  type: "string" | "number" | "date" | "boolean" | "object";
  required: boolean;
  example: string;
}

/** The localized subject + HTML + plain-text variants of a template. */
export interface LocalizedTemplateTranslation {
  subject: string;
  html: string;
  text: string;
  placeholders: LocalizedTemplatePlaceholder[];
}

/**
 * A fully managed notification template with translations across multiple
 * locales and an explicit fallback chain used to resolve missing locales.
 */
export interface LocalizedTemplate {
  id: string;
  name: string;
  defaultLocale: string;
  translations: Record<string, LocalizedTemplateTranslation>;
  fallbackChain: string[];
  lastUpdated: string;
  updatedBy: string;
}

/** Lifecycle states of a translation job in the collaboration workflow. */
export type TranslationJobStatus =
  | "pending"
  | "in_progress"
  | "review"
  | "approved"
  | "published"
  | "cancelled";

/** A single unit of work assigned to a translator. */
export interface TranslationJob {
  id: string;
  templateId: string;
  sourceLocale: string;
  targetLocales: string[];
  status: TranslationJobStatus;
  assignedTo: string;
  dueDate: string;
  createdAt: string;
}

/** Static metadata describing a supported locale. */
export interface LocaleConfig {
  code: string;
  name: string;
  nativeName: string;
  rtl: boolean;
  dateFormat: string;
  numberFormat: string;
  currencyFormat: string;
  pluralRules: string; // ICU plural categories, e.g. "one;few;many;other"
  fallback: string;
}

/** A single validation problem found in a translation. */
export interface ValidationIssue {
  field: string;
  message: string;
  placeholder?: string;
}

/** Result of validating one locale's translation of a template. */
export interface ValidationResult {
  locale: string;
  valid: boolean;
  errors: ValidationIssue[];
  warnings: string[];
}

/** Result of rendering a localized template. */
export interface RenderedLocalizedTemplate {
  templateId: string;
  subject: string;
  html: string;
  text: string;
  /** The locale that was actually used (after fallback resolution). */
  locale: string;
  /** Whether the resolved locale is right-to-left. */
  rtl: boolean;
  /** Placeholders referenced by the template that had no provided value. */
  missing: string[];
}
