// Issue #214
import { 
  type UserNotificationPreferences, 
  type NotificationEventType,
  getEnabledChannels
} from "./preferences.js";

// Issue #357 — re-export i18n utilities so consumers only need to import from router
export {
  loadTranslations,
  interpolate,
  SUPPORTED_LOCALES,
  type Translations,
  type SupportedLocale,
} from "./i18n/index.js";
export { renderLocalizedTemplate, type LocalizedTemplateResult } from "./i18n/localized-template.js";

// Issue #116 — template localization system (ICU, fallback chains, RTL,
// validation, locale detection, translation memory, translator workflow).
export {
  LocalizationManager,
  localizationManager,
  TemplateNotFoundError,
  seedLocalizationManager,
  buildLocalizedTemplate,
  detectLocale,
  parseAcceptLanguage,
  resolveFallbackChain,
  isRtlLocale,
  getLocaleConfig,
  formatIcu,
  formatIcuMessage,
  validateTemplate,
  isTemplateValid,
  TranslationWorkflow,
  translationWorkflow,
  TranslationMemory,
  translationMemory,
  LOCALE_CONFIGS,
  LOCALE_COUNT,
  type LocalizedTemplate,
  type LocaleConfig,
  type TranslationJob,
  type ValidationResult,
  type RenderedLocalizedTemplate,
} from "./i18n/index.js";
export interface ContractNotificationRoute {
  eventType: string;
  templateName: string;
  channels: Array<"email" | "push">;
}

const ROUTE_TABLE: ContractNotificationRoute[] = [
  // Escrow events
  { eventType: "escrow.created",            templateName: "escrow-created",    channels: ["email", "push"] },
  { eventType: "escrow.released",           templateName: "escrow-released",   channels: ["email", "push"] },
  { eventType: "escrow.refunded",           templateName: "escrow-refunded",   channels: ["email", "push"] },
  { eventType: "escrow.disputed",           templateName: "escrow-disputed",   channels: ["email", "push"] },
  // Legacy alias kept for backwards-compat
  { eventType: "escrow.locked",             templateName: "approval-request",  channels: ["email", "push"] },
  // Payment events
  { eventType: "payment.failed",            templateName: "payment-failed",    channels: ["email"] },
  // Permission events
  { eventType: "permission.granted",        templateName: "permission-granted",   channels: ["push"] },
  { eventType: "permission.revoked",        templateName: "permission-revoked",   channels: ["push"] },
  { eventType: "permission.expiry_updated", templateName: "permission-updated",   channels: ["push"] },
  // Transaction approval
  { eventType: "transaction_approval",      templateName: "approval-request",     channels: ["email", "push"] },
];

// Supported locales mirrored here to avoid a circular import with i18n/index.js.
const _SUPPORTED_LOCALES: readonly string[] = ["en", "es", "fr"];

export function routeContractEvent(eventType: string): ContractNotificationRoute | null {
  return ROUTE_TABLE.find((r) => r.eventType === eventType) ?? null;
}

export function routeContractEventWithPreferences(
  eventType: string,
  userPreferences: UserNotificationPreferences | null
): ContractNotificationRoute | null {
  const baseRoute = ROUTE_TABLE.find((r) => r.eventType === eventType);
  if (!baseRoute) return null;
  if (!userPreferences) return baseRoute;
  const enabledChannels = getEnabledChannels(userPreferences, eventType as NotificationEventType);
  if (enabledChannels.length === 0) return null;
  return { ...baseRoute, channels: enabledChannels as Array<"email" | "push"> };
}

/**
 * Issue #357 — Combine preference filtering with locale selection.
 *
 * Returns the matched route extended with a `locale` field (resolved after
 * fallback to 'en' for unsupported locales), or `null` when the event is
 * unknown or all channels are disabled for the user.
 */
export function routeContractEventWithLocale(
  eventType: string,
  locale: string,
  userPreferences: UserNotificationPreferences | null
): (ContractNotificationRoute & { locale: string }) | null {
  const baseRoute = routeContractEventWithPreferences(eventType, userPreferences);
  if (!baseRoute) return null;

  const normalisedLocale = locale.toLowerCase();
  const resolvedLocale = _SUPPORTED_LOCALES.includes(normalisedLocale)
    ? normalisedLocale
    : "en";

  return { ...baseRoute, locale: resolvedLocale };
}
