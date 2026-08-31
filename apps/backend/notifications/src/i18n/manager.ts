// Issue #116 — Template localization manager. Registers LocalizedTemplates,
// resolves the best available locale through fallback chains, renders with the
// ICU engine, and reports missing placeholders. It is the translation
// management system: the single place to add, retrieve, validate, and render
// localized notification templates.

import type { LocalizedTemplate, RenderedLocalizedTemplate } from "./types.js";
import { formatIcuMessage, normalizeLegacyPlaceholders, IcuSyntaxError } from "./icu.js";
import {
  getLocaleConfig,
  isRtlLocale,
  resolveFallbackChain,
  normalizeLocaleCode,
} from "./locales.js";
import { validateTemplate } from "./validate.js";
import { detectLocale } from "./detect.js";

export interface RenderResult extends RenderedLocalizedTemplate {
  /** Locales attempted (requested → fallbacks) when resolving. */
  attemptedLocales: string[];
}

export class TemplateNotFoundError extends Error {
  constructor(id: string) {
    super(`Localized template not found: ${id}`);
    this.name = "TemplateNotFoundError";
  }
}

/**
 * The translation management system for notification templates.
 */
export class LocalizationManager {
  private templates = new Map<string, LocalizedTemplate>();

  register(template: LocalizedTemplate): void {
    if (!template.id) throw new Error("Template id is required");
    if (!template.translations || Object.keys(template.translations).length === 0) {
      throw new Error(`Template "${template.id}" must declare at least one translation`);
    }
    const defaultTranslation = template.translations[template.defaultLocale];
    if (!defaultTranslation) {
      throw new Error(
        `Template "${template.id}" is missing its defaultLocale translation (${template.defaultLocale})`
      );
    }
    this.templates.set(template.id, template);
  }

  get(id: string): LocalizedTemplate | undefined {
    return this.templates.get(id);
  }

  list(): LocalizedTemplate[] {
    return [...this.templates.values()];
  }

  remove(id: string): boolean {
    return this.templates.delete(id);
  }

  /** Locales that actually have a translation for the given template. */
  availableLocales(templateId: string): string[] {
    const template = this.templates.get(templateId);
    if (!template) return [];
    return Object.keys(template.translations);
  }

  /**
   * Resolve the best locale for a render. Returns an ordered candidate list
   * (resolved locale first, then its fallback chain) that always terminates
   * at the template's default locale.
   */
  resolveLocale(
    template: LocalizedTemplate,
    requested?: string
  ): { locale: string; candidates: string[] } {
    const available = this.availableLocales(template.id);
    const defaultLocale = normalizeLocaleCode(template.defaultLocale) ?? "en";

    if (requested) {
      const base = normalizeLocaleCode(requested);
      if (base && available.includes(base)) {
        return { locale: base, candidates: [base] };
      }
      if (base) {
        // Requested locale known but untranslated — walk its fallback chain.
        const chain = resolveFallbackChain(base);
        for (const candidate of chain) {
          if (available.includes(candidate)) {
            return { locale: candidate, candidates: chain.slice(0, chain.indexOf(candidate) + 1) };
          }
        }
        // No translation anywhere in the requested chain — use the template
        // default locale, but still report what was attempted.
        return { locale: defaultLocale, candidates: [...chain, defaultLocale] };
      }
    }

    // Detection fallback: prefer the template's own fallbackChain, then the
    // registry fallback chains, then the template default locale.
    const preferred = [
      ...template.fallbackChain.filter((l) => normalizeLocaleCode(l) !== null),
      defaultLocale,
    ];
    const resolved = detectLocale(preferred, available, defaultLocale);
    const candidates = [...resolveFallbackChain(resolved)];
    return { locale: resolved, candidates };
  }

  /**
   * Render a template for a user locale. Falls back along the locale fallback
   * chain (and ultimately to the template default locale) when the requested
   * locale has no translation.
   */
  render(id: string, requestedLocale: string | undefined, variables: Record<string, unknown>): RenderResult {
    const template = this.templates.get(id);
    if (!template) throw new TemplateNotFoundError(id);

    const { locale, candidates } = this.resolveLocale(template, requestedLocale);
    const translation = template.translations[locale];
    const missing: string[] = [];

    const renderPart = (value: string): string => {
      const normalized = normalizeLegacyPlaceholders(value);
      const { text, missing: partMissing } = formatIcuMessage(
        normalized,
        variables,
        locale
      );
      for (const m of partMissing) {
        if (!missing.includes(m)) missing.push(m);
      }
      return text;
    };

    const subject = renderPart(translation.subject);
    const text = renderPart(translation.text);
    let html = renderPart(translation.html);

    const rtl = isRtlLocale(locale);
    if (rtl && html && !html.includes('dir="rtl"')) {
      html = `<div dir="rtl" lang="${locale}">${html}</div>`;
    }

    return {
      templateId: id,
      subject,
      html,
      text,
      locale,
      rtl,
      missing,
      attemptedLocales: candidates,
    };
  }

  /** Validate every translation of every registered template. */
  validate(id?: string) {
    const templates = id ? [this.get(id)] : this.list();
    const results: Array<{ templateId: string; result: ReturnType<typeof validateTemplate> }> = [];
    for (const template of templates) {
      if (!template) continue;
      results.push({ templateId: template.id, result: validateTemplate(template) });
    }
    return results;
  }
}

/** Shared singleton used across the notification service. */
export const localizationManager = new LocalizationManager();

export { isRtlLocale, getLocaleConfig, IcuSyntaxError };
