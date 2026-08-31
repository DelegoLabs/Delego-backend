// Issue #116 — Tests for translation validation.
import { describe, it, expect } from "vitest";
import type { LocalizedTemplate } from "./types.js";
import {
  validateIcuSyntax,
  validateTemplate,
  validateTemplateTranslation,
  isTemplateValid,
  translationArguments,
} from "./validate.js";

const basePlaceholders = [
  { name: "orderId", type: "string" as const, required: true, example: "ORD-1" },
  { name: "amount", type: "number" as const, required: true, example: "10" },
  { name: "merchant", type: "string" as const, required: false, example: "Shop" },
];

const baseTemplate: LocalizedTemplate = {
  id: "escrow_released",
  name: "Escrow released",
  defaultLocale: "en",
  translations: {
    en: {
      subject: "Escrow released for order {orderId}",
      html: "<p>Funds of {amount} sent to {merchant}.</p>",
      text: "Funds of {amount} sent to {merchant}.",
      placeholders: basePlaceholders,
    },
    es: {
      subject: "Depósito liberado para el pedido {orderId}",
      html: "<p>Fondos de {amount} enviados a {merchant}.</p>",
      text: "Fondos de {amount} enviados a {merchant}.",
      placeholders: basePlaceholders,
    },
  },
  fallbackChain: ["en"],
  lastUpdated: "",
  updatedBy: "system",
};

describe("validateIcuSyntax", () => {
  it("accepts valid ICU", () => {
    expect(validateIcuSyntax("You have {count, plural, one {# item} other {# items}}")).toEqual([]);
  });

  it("rejects invalid ICU", () => {
    expect(validateIcuSyntax("Hello {name").length).toBeGreaterThan(0);
    expect(validateIcuSyntax("Hello }")).not.toEqual([]);
  });
});

describe("validateTemplateTranslation", () => {
  it("returns valid for a well-formed translation", () => {
    const result = validateTemplateTranslation(baseTemplate, "en");
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("catches ICU syntax errors in any field", () => {
    const bad = structuredClone(baseTemplate);
    bad.translations.en.subject = "Broken {placeholder";
    const result = validateTemplateTranslation(bad, "en");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "subject")).toBe(true);
  });

  it("catches placeholders used but not declared", () => {
    const bad = structuredClone(baseTemplate);
    bad.translations.en.subject = "Hello {undeclared}";
    const result = validateTemplateTranslation(bad, "en");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.placeholder === "undeclared")).toBe(true);
  });

  it("catches missing required placeholders", () => {
    const bad = structuredClone(baseTemplate);
    bad.translations.en.subject = "Escrow released";
    bad.translations.en.text = "No placeholders";
    bad.translations.en.html = "No placeholders";
    const result = validateTemplateTranslation(bad, "en");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.placeholder === "orderId")).toBe(true);
  });

  it("warns about declared-but-unused placeholders", () => {
    const tpl = structuredClone(baseTemplate);
    const result = validateTemplateTranslation(tpl, "en");
    // merchant is optional and unused in the subject but used in html/text, so
    // no warning; orderId/amount are used. Add an unused optional placeholder.
    tpl.translations.en.placeholders.push({
      name: "unusedVar",
      type: "string",
      required: false,
      example: "x",
    });
    const withUnused = validateTemplateTranslation(tpl, "en");
    expect(withUnused.valid).toBe(true);
    expect(withUnused.warnings.some((w) => w.includes("unusedVar"))).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("errors when the translation is missing entirely", () => {
    const tpl = structuredClone(baseTemplate);
    const result = validateTemplateTranslation(tpl, "de");
    expect(result.valid).toBe(false);
  });
});

describe("validateTemplate / isTemplateValid", () => {
  it("validates every locale", () => {
    const results = validateTemplate(baseTemplate);
    expect(results.map((r) => r.locale).sort()).toEqual(["en", "es"]);
    expect(results.every((r) => r.valid)).toBe(true);
    expect(isTemplateValid(baseTemplate)).toBe(true);
  });

  it("flags invalid templates", () => {
    const bad = structuredClone(baseTemplate);
    bad.translations.es.subject = "Oops {";
    expect(isTemplateValid(bad)).toBe(false);
  });
});

describe("translationArguments", () => {
  it("collects arguments across all fields", () => {
    const args = translationArguments(
      "Hello {name}",
      "<p>{name} {count, plural, one {x} other {y}}</p>",
      "bye"
    );
    expect(args.has("name")).toBe(true);
    expect(args.has("count")).toBe(true);
  });
});
