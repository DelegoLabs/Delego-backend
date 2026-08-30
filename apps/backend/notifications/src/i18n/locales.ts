// Issue #116 — Locale registry. Declares the LocaleConfig for every supported
// locale (30+), including RTL flags and ICU plural categories, and provides
// fallback-chain resolution used when a locale has no bundled translation.

import type { LocaleConfig } from "./types.js";

/** 30+ supported locales, ordered from most to least common. */
export const LOCALE_CONFIGS: LocaleConfig[] = [
  { code: "en",    name: "English",              nativeName: "English",                rtl: false, dateFormat: "yyyy-MM-dd", numberFormat: "en-US",    currencyFormat: "USD $",     pluralRules: "one;other",         fallback: "" },
  { code: "es",    name: "Spanish",              nativeName: "Español",                rtl: false, dateFormat: "dd/MM/yyyy",  numberFormat: "es-ES",    currencyFormat: "EUR €",     pluralRules: "one;other",         fallback: "" },
  { code: "fr",    name: "French",               nativeName: "Français",               rtl: false, dateFormat: "dd/MM/yyyy",  numberFormat: "fr-FR",    currencyFormat: "EUR €",     pluralRules: "one;other",         fallback: "" },
  { code: "de",    name: "German",               nativeName: "Deutsch",                rtl: false, dateFormat: "dd.MM.yyyy",  numberFormat: "de-DE",    currencyFormat: "EUR €",     pluralRules: "one;other",         fallback: "" },
  { code: "it",    name: "Italian",              nativeName: "Italiano",               rtl: false, dateFormat: "dd/MM/yyyy",  numberFormat: "it-IT",    currencyFormat: "EUR €",     pluralRules: "one;other",         fallback: "" },
  { code: "pt",    name: "Portuguese",           nativeName: "Português",              rtl: false, dateFormat: "dd/MM/yyyy",  numberFormat: "pt-PT",    currencyFormat: "EUR €",     pluralRules: "one;other",         fallback: "" },
  { code: "pt-BR", name: "Portuguese (Brazil)",  nativeName: "Português (Brasil)",     rtl: false, dateFormat: "dd/MM/yyyy",  numberFormat: "pt-BR",    currencyFormat: "BRL R$",    pluralRules: "one;other",         fallback: "pt" },
  { code: "nl",    name: "Dutch",                nativeName: "Nederlands",             rtl: false, dateFormat: "dd-MM-yyyy",  numberFormat: "nl-NL",    currencyFormat: "EUR €",     pluralRules: "one;other",         fallback: "" },
  { code: "pl",    name: "Polish",               nativeName: "Polski",                 rtl: false, dateFormat: "dd.MM.yyyy",  numberFormat: "pl-PL",    currencyFormat: "PLN zł",    pluralRules: "one;few;many;other", fallback: "" },
  { code: "ru",    name: "Russian",              nativeName: "Русский",                rtl: false, dateFormat: "dd.MM.yyyy",  numberFormat: "ru-RU",    currencyFormat: "RUB ₽",     pluralRules: "one;few;many;other", fallback: "" },
  { code: "uk",    name: "Ukrainian",            nativeName: "Українська",             rtl: false, dateFormat: "dd.MM.yyyy",  numberFormat: "uk-UA",    currencyFormat: "UAH ₴",     pluralRules: "one;few;many;other", fallback: "" },
  { code: "cs",    name: "Czech",                nativeName: "Čeština",                rtl: false, dateFormat: "dd.MM.yyyy",  numberFormat: "cs-CZ",    currencyFormat: "CZK Kč",    pluralRules: "one;few;many;other", fallback: "" },
  { code: "ro",    name: "Romanian",             nativeName: "Română",                 rtl: false, dateFormat: "dd.MM.yyyy",  numberFormat: "ro-RO",    currencyFormat: "RON lei",   pluralRules: "one;few;other",      fallback: "" },
  { code: "hu",    name: "Hungarian",            nativeName: "Magyar",                 rtl: false, dateFormat: "yyyy.MM.dd.", numberFormat: "hu-HU",    currencyFormat: "HUF Ft",    pluralRules: "one;other",         fallback: "" },
  { code: "tr",    name: "Turkish",              nativeName: "Türkçe",                 rtl: false, dateFormat: "dd.MM.yyyy",  numberFormat: "tr-TR",    currencyFormat: "TRY ₺",     pluralRules: "one;other",         fallback: "" },
  { code: "sv",    name: "Swedish",              nativeName: "Svenska",                rtl: false, dateFormat: "yyyy-MM-dd",  numberFormat: "sv-SE",    currencyFormat: "SEK kr",    pluralRules: "one;other",         fallback: "" },
  { code: "da",    name: "Danish",               nativeName: "Dansk",                  rtl: false, dateFormat: "dd.MM.yyyy",  numberFormat: "da-DK",    currencyFormat: "DKK kr",    pluralRules: "one;other",         fallback: "" },
  { code: "fi",    name: "Finnish",              nativeName: "Suomi",                  rtl: false, dateFormat: "d.M.yyyy",    numberFormat: "fi-FI",    currencyFormat: "EUR €",     pluralRules: "one;other",         fallback: "" },
  { code: "no",    name: "Norwegian",            nativeName: "Norsk",                  rtl: false, dateFormat: "dd.MM.yyyy",  numberFormat: "nb-NO",    currencyFormat: "NOK kr",    pluralRules: "one;other",         fallback: "" },
  { code: "el",    name: "Greek",                nativeName: "Ελληνικά",               rtl: false, dateFormat: "dd/MM/yyyy",  numberFormat: "el-GR",    currencyFormat: "EUR €",     pluralRules: "one;other",         fallback: "" },
  { code: "hi",    name: "Hindi",                nativeName: "हिन्दी",                 rtl: false, dateFormat: "dd/MM/yyyy",  numberFormat: "hi-IN",    currencyFormat: "INR ₹",     pluralRules: "one;other",         fallback: "" },
  { code: "id",    name: "Indonesian",           nativeName: "Bahasa Indonesia",       rtl: false, dateFormat: "dd/MM/yyyy",  numberFormat: "id-ID",    currencyFormat: "IDR Rp",    pluralRules: "other",              fallback: "" },
  { code: "ja",    name: "Japanese",             nativeName: "日本語",                 rtl: false, dateFormat: "yyyy/MM/dd",  numberFormat: "ja-JP",    currencyFormat: "JPY ¥",     pluralRules: "other",              fallback: "" },
  { code: "ko",    name: "Korean",               nativeName: "한국어",                 rtl: false, dateFormat: "yyyy.M.d.",   numberFormat: "ko-KR",    currencyFormat: "KRW ₩",     pluralRules: "other",              fallback: "" },
  { code: "zh",    name: "Chinese",              nativeName: "中文",                   rtl: false, dateFormat: "yyyy/M/d",    numberFormat: "zh-CN",    currencyFormat: "CNY ¥",     pluralRules: "other",              fallback: "" },
  { code: "zh-CN", name: "Chinese (Simplified)", nativeName: "简体中文",               rtl: false, dateFormat: "yyyy/M/d",    numberFormat: "zh-CN",    currencyFormat: "CNY ¥",     pluralRules: "other",              fallback: "zh" },
  { code: "zh-TW", name: "Chinese (Traditional)",nativeName: "繁體中文",               rtl: false, dateFormat: "yyyy/M/d",    numberFormat: "zh-TW",    currencyFormat: "TWD NT$",   pluralRules: "other",              fallback: "zh" },
  { code: "vi",    name: "Vietnamese",           nativeName: "Tiếng Việt",             rtl: false, dateFormat: "dd/MM/yyyy",  numberFormat: "vi-VN",    currencyFormat: "VND ₫",     pluralRules: "other",              fallback: "" },
  { code: "th",    name: "Thai",                 nativeName: "ไทย",                   rtl: false, dateFormat: "d/M/yyyy",    numberFormat: "th-TH",    currencyFormat: "THB ฿",     pluralRules: "other",              fallback: "" },
  { code: "ar",    name: "Arabic",               nativeName: "العربية",                rtl: true,  dateFormat: "dd/MM/yyyy",  numberFormat: "ar-EG",    currencyFormat: "EGP ج.م",   pluralRules: "zero;one;two;few;many;other", fallback: "" },
  { code: "he",    name: "Hebrew",               nativeName: "עברית",                  rtl: true,  dateFormat: "dd/MM/yyyy",  numberFormat: "he-IL",    currencyFormat: "ILS ₪",     pluralRules: "one;two;many;other", fallback: "" },
  { code: "fa",    name: "Persian",              nativeName: "فارسی",                  rtl: true,  dateFormat: "yyyy/MM/dd",  numberFormat: "fa-IR",    currencyFormat: "IRR ریال",  pluralRules: "one;other",         fallback: "" },
  { code: "ur",    name: "Urdu",                 nativeName: "اردو",                   rtl: true,  dateFormat: "dd/MM/yyyy",  numberFormat: "ur-PK",    currencyFormat: "PKR ₨",     pluralRules: "one;other",         fallback: "" },
  { code: "ta",    name: "Tamil",                nativeName: "தமிழ்",                  rtl: false, dateFormat: "dd/MM/yyyy",  numberFormat: "ta-IN",    currencyFormat: "INR ₹",     pluralRules: "one;other",         fallback: "" },
];

const configByCode = new Map<string, LocaleConfig>();
for (const config of LOCALE_CONFIGS) {
  configByCode.set(config.code.toLowerCase(), config);
}

/** Normalise a BCP-47 tag to a registered locale code (or null). */
export function normalizeLocaleCode(locale: string): string | null {
  if (!locale) return null;
  const lower = locale.toLowerCase().replace("_", "-");
  // Exact match first.
  if (configByCode.has(lower)) return configByCode.get(lower)!.code;
  // Fall back to the primary subtag (e.g. en-US -> en).
  const primary = lower.split("-")[0];
  if (configByCode.has(primary)) return configByCode.get(primary)!.code;
  // Try region-tagged codes by matching the primary subtag.
  for (const [code] of configByCode) {
    if (code.startsWith(`${primary}-`)) return configByCode.get(code)!.code;
  }
  return null;
}

export function getLocaleConfig(locale: string): LocaleConfig | undefined {
  const code = normalizeLocaleCode(locale);
  if (!code) return undefined;
  return configByCode.get(code.toLowerCase());
}

/** Number of registered locales. */
export const LOCALE_COUNT = LOCALE_CONFIGS.length;

/** True when the locale is registered and right-to-left. */
export function isRtlLocale(locale: string): boolean {
  return getLocaleConfig(locale)?.rtl ?? false;
}

/**
 * Resolve the fallback chain for a locale. The chain starts with the locale
 * itself and walks `LocaleConfig.fallback` links up to the root (`""`).
 * Example: `pt-BR -> pt -> en` (when the manager seeds `en` as the root).
 */
export function resolveFallbackChain(locale: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = normalizeLocaleCode(locale);
  while (current && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    const config = configByCode.get(current.toLowerCase());
    if (!config) break;
    if (!config.fallback) break;
    const next = normalizeLocaleCode(config.fallback);
    if (!next) break;
    current = next;
  }
  return chain;
}

/** All registered locale codes. */
export function supportedLocaleCodes(): string[] {
  return LOCALE_CONFIGS.map((c) => c.code);
}
