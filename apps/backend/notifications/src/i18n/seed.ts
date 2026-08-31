// Issue #116 — Seed the LocalizationManager from the bundled flat JSON
// translation files (en/es/fr) so existing templates work through the new
// ICU-based manager without duplicating data.

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  LocalizedTemplate,
  LocalizedTemplatePlaceholder,
} from "./types.js";
import { extractIcuArguments, normalizeLegacyPlaceholders } from "./icu.js";
import type { LocalizationManager } from "./manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Known event templates and the example values used for placeholder docs. */
export const SEED_TEMPLATES: Array<{
  id: string;
  name: string;
  event: string;
}> = [
  { id: "escrow_created", name: "Escrow created", event: "escrow.created" },
  { id: "escrow_released", name: "Escrow released", event: "escrow.released" },
  { id: "escrow_refunded", name: "Escrow refunded", event: "escrow.refunded" },
  { id: "escrow_disputed", name: "Escrow disputed", event: "escrow.disputed" },
  { id: "payment_failed", name: "Payment failed", event: "payment.failed" },
  { id: "permission_granted", name: "Permission granted", event: "permission.granted" },
  { id: "permission_revoked", name: "Permission revoked", event: "permission.revoked" },
  { id: "permission_expiry_updated", name: "Permission expiry updated", event: "permission.expiry_updated" },
  { id: "transaction_approval", name: "Transaction approval", event: "transaction_approval" },
];

const PLACEHOLDER_EXAMPLES: Record<string, string> = {
  orderId: "ORD-123",
  amount: "10 XLM",
  merchant: "Acme Corp",
  buyer: "Alice",
  delegate: "agent-42",
  owner: "Alice",
  newExpiry: "500000",
  approvalUrl: "https://delego.app/approve/123",
  reason: "Insufficient balance",
  txHash: "a1b2c3d4e5f6...",
};

const BUNDLED_LOCALES = ["en", "es", "fr"] as const;

type FlatTranslations = Record<string, string>;

function loadFlatTranslations(locale: string): FlatTranslations | null {
  const filePath = resolve(__dirname, `${locale}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as FlatTranslations;
  } catch {
    return null;
  }
}

function buildPlaceholders(subject: string, body: string): LocalizedTemplatePlaceholder[] {
  const args = extractIcuArguments(
    normalizeLegacyPlaceholders(`${subject} ${body}`)
  );
  return args.map((name) => ({
    name,
    type: "string",
    required: true,
    example: PLACEHOLDER_EXAMPLES[name] ?? `{${name}}`,
  }));
}

/** Build a LocalizedTemplate for a seeded event type using bundled JSON. */
export function buildLocalizedTemplate(
  id: string,
  name: string
): LocalizedTemplate {
  const translations: LocalizedTemplate["translations"] = {};
  let placeholders: LocalizedTemplatePlaceholder[] = [];

  for (const locale of BUNDLED_LOCALES) {
    const flat = loadFlatTranslations(locale);
    if (!flat) continue;
    const subject = flat[`${id}_subject`] ?? "";
    const body = flat[`${id}_body`] ?? "";
    if (locale === "en") {
      placeholders = buildPlaceholders(subject, body);
    }
    translations[locale] = {
      subject,
      html: `<p>${body.replace(/\n/g, "<br>")}</p>`,
      text: body,
      placeholders,
    };
  }

  return {
    id,
    name,
    defaultLocale: "en",
    translations,
    fallbackChain: ["en"],
    lastUpdated: new Date("2026-01-01T00:00:00Z").toISOString(),
    updatedBy: "system",
  };
}

/** Register all bundled templates (including dot-named aliases) on a manager. */
export function seedLocalizationManager(manager: LocalizationManager): void {
  for (const { id, name, event } of SEED_TEMPLATES) {
    const template = buildLocalizedTemplate(id, name);
    manager.register(template);
    if (event !== id) {
      // Alias so both `escrow.created` and `escrow_created` resolve.
      manager.register({ ...template, id: event });
    }
  }
}
