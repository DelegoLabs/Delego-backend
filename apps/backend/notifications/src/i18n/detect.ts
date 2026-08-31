// Issue #116 — Locale detection. Parses Accept-Language style preference
// lists (with q-values) and resolves them against the supported locale set,
// honouring fallback chains.

import {
  getLocaleConfig,
  normalizeLocaleCode,
  resolveFallbackChain,
} from "./locales.js";

interface Preference {
  tag: string;
  q: number;
}

/** Parse an Accept-Language header into ordered preferences. */
export function parseAcceptLanguage(header: string): Preference[] {
  if (!header) return [];
  const prefs: Preference[] = [];
  for (const part of header.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [tag, ...params] = trimmed.split(";");
    let q = 1;
    for (const param of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
      if (m) {
        const parsed = Number(m[1]);
        if (!Number.isNaN(parsed)) q = parsed;
      }
    }
    if (q > 0) prefs.push({ tag: tag.trim(), q });
  }
  return prefs.sort((a, b) => b.q - a.q);
}

/** The language priority list from a user (e.g. `navigator.languages`). */
export type LanguageList = Array<string | { tag: string; q?: number }>;

function toPreferences(languages: LanguageList): Preference[] {
  const prefs: Preference[] = [];
  for (const entry of languages) {
    if (typeof entry === "string") {
      prefs.push({ tag: entry, q: 1 });
    } else {
      prefs.push({ tag: entry.tag, q: entry.q ?? 1 });
    }
  }
  return prefs.sort((a, b) => b.q - a.q);
}

/**
 * Resolve the best locale for a user given their preferences and the set of
 * locales that actually have translations. Matching is per the BCP-47 lookup
 * algorithm with region fallback (`en-GB` → `en`), and when no preference
 * matches directly the per-locale fallback chain is walked.
 */
export function detectLocale(
  preferences: LanguageList | string,
  availableLocales: readonly string[],
  defaultLocale = "en"
): string {
  const prefs =
    typeof preferences === "string"
      ? parseAcceptLanguage(preferences)
      : toPreferences(preferences);

  const available = new Set(availableLocales.map((l) => l.toLowerCase()));

  for (const pref of prefs) {
    const normalized = normalizeLocaleCode(pref.tag);
    if (!normalized) continue;
    // Exact or primary-subtag match.
    if (available.has(normalized.toLowerCase())) return normalized;
    // Walk the fallback chain looking for an available locale.
    for (const candidate of resolveFallbackChain(normalized)) {
      if (available.has(candidate.toLowerCase())) return candidate;
    }
  }

  // Nothing matched — try the default and then its fallback chain.
  const fallback = normalizeLocaleCode(defaultLocale) ?? "en";
  for (const candidate of [fallback, ...resolveFallbackChain(fallback)]) {
    if (available.has(candidate.toLowerCase())) return candidate;
  }
  return fallback;
}

/** Whether the given locale exists in the registry. */
export function isKnownLocale(locale: string): boolean {
  return getLocaleConfig(locale) !== undefined;
}
