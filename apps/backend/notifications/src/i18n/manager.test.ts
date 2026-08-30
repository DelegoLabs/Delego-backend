// Issue #116 — Tests for the LocalizationManager (translation management
// system): registration, ICU rendering, fallback chains, RTL, detection, and
// validation.
import { describe, it, expect } from "vitest";
import {
  LocalizationManager,
  TemplateNotFoundError,
} from "./manager.js";
import { seedLocalizationManager } from "./seed.js";
import type { LocalizedTemplate } from "./types.js";

function makeTemplate(overrides: Partial<LocalizedTemplate> = {}): LocalizedTemplate {
  const base: LocalizedTemplate = {
    id: "order_update",
    name: "Order update",
    defaultLocale: "en",
    translations: {
      en: {
        subject: "You have {count, plural, one {# new update} other {# new updates}} on order {orderId}",
        html: "<p>Order {orderId} status: {status}.</p>",
        text: "Order {orderId} status: {status}.",
        placeholders: [
          { name: "count", type: "number", required: true, example: "1" },
          { name: "orderId", type: "string", required: true, example: "ORD-1" },
          { name: "status", type: "string", required: true, example: "shipped" },
        ],
      },
      ar: {
        subject: "لديك {count, plural, zero {لا تحديثات} one {تحديث واحد} two {تحديثان} few {تحديثات} many {تحديث} other {تحديثات}} على الطلب {orderId}",
        html: "<p>حالة الطلب {orderId}: {status}.</p>",
        text: "حالة الطلب {orderId}: {status}.",
        placeholders: [
          { name: "count", type: "number", required: true, example: "1" },
          { name: "orderId", type: "string", required: true, example: "ORD-1" },
          { name: "status", type: "string", required: true, example: "shipped" },
        ],
      },
    },
    fallbackChain: ["en"],
    lastUpdated: "2026-08-01T00:00:00Z",
    updatedBy: "system",
  };
  return { ...base, ...overrides };
}

describe("LocalizationManager registration", () => {
  it("registers, gets, lists, and removes templates", () => {
    const manager = new LocalizationManager();
    manager.register(makeTemplate());
    expect(manager.get("order_update")).toBeDefined();
    expect(manager.list().length).toBe(1);
    expect(manager.remove("order_update")).toBe(true);
    expect(manager.list().length).toBe(0);
  });

  it("rejects templates without a defaultLocale translation", () => {
    const manager = new LocalizationManager();
    const bad = makeTemplate({ translations: { es: makeTemplate().translations.en } });
    expect(() => manager.register(bad)).toThrow(/defaultLocale/);
  });
});

describe("LocalizationManager rendering", () => {
  it("renders ICU pluralization for the default locale", () => {
    const manager = new LocalizationManager();
    manager.register(makeTemplate());
    const one = manager.render("order_update", "en", { count: 1, orderId: "ORD-1", status: "shipped" });
    const many = manager.render("order_update", "en", { count: 7, orderId: "ORD-1", status: "shipped" });
    expect(one.subject).toContain("1 new update");
    expect(many.subject).toContain("7 new updates");
    expect(one.missing).toEqual([]);
  });

  it("renders Arabic with correct plural categories and RTL wrapper", () => {
    const manager = new LocalizationManager();
    manager.register(makeTemplate());
    const two = manager.render("order_update", "ar", { count: 2, orderId: "ORD-1", status: "shipped" });
    expect(two.locale).toBe("ar");
    expect(two.rtl).toBe(true);
    expect(two.subject).toContain("تحديثان");
    expect(two.html).toContain('dir="rtl"');
    expect(two.html).toContain('lang="ar"');
  });

  it("falls back to the default locale when the requested locale is untranslated", () => {
    const manager = new LocalizationManager();
    manager.register(makeTemplate());
    const result = manager.render("order_update", "de", { count: 1, orderId: "ORD-1", status: "shipped" });
    expect(result.locale).toBe("en");
    expect(result.subject).toContain("1 new update");
    expect(result.attemptedLocales).toContain("de");
  });

  it("walks the locale fallback chain (pt-BR -> pt) before defaulting", () => {
    const manager = new LocalizationManager();
    const template = makeTemplate();
    template.translations.pt = {
      subject: "Você tem {count, plural, one {# nova atualização} other {# novas atualizações}} no pedido {orderId}",
      html: "<p>Pedido {orderId}: {status}.</p>",
      text: "Pedido {orderId}: {status}.",
      placeholders: template.translations.en.placeholders,
    };
    manager.register(template);
    const result = manager.render("order_update", "pt-BR", { count: 3, orderId: "ORD-1", status: "shipped" });
    expect(result.locale).toBe("pt");
    expect(result.subject).toContain("3 novas atualizações");
    expect(result.attemptedLocales).toEqual(["pt-BR", "pt"]);
  });

  it("reports missing placeholders", () => {
    const manager = new LocalizationManager();
    manager.register(makeTemplate());
    const result = manager.render("order_update", "en", { count: 1 });
    expect(result.missing.sort()).toEqual(["orderId", "status"]);
    expect(result.text).toContain("{orderId}");
  });

  it("throws for unknown templates", () => {
    const manager = new LocalizationManager();
    expect(() => manager.render("nope", "en", {})).toThrow(TemplateNotFoundError);
  });
});

describe("seeded templates (legacy {{key}} JSON)", () => {
  it("seeds all bundled templates including dot aliases", () => {
    const manager = new LocalizationManager();
    seedLocalizationManager(manager);
    expect(manager.get("escrow_released")).toBeDefined();
    expect(manager.get("escrow.released")).toBeDefined();
    expect(manager.list().length).toBeGreaterThanOrEqual(9);
  });

  it("renders legacy {{key}} templates through the ICU engine", () => {
    const manager = new LocalizationManager();
    seedLocalizationManager(manager);
    const result = manager.render("escrow_released", "en", {
      orderId: "ORD-999",
      amount: "5 XLM",
      merchant: "TechShop",
    });
    expect(result.subject).toContain("ORD-999");
    expect(result.text).toBeDefined();
    expect(result.missing).toEqual([]);
  });

  it("renders Spanish when requested", () => {
    const manager = new LocalizationManager();
    seedLocalizationManager(manager);
    const en = manager.render("payment.failed", "en", { orderId: "O1", amount: "2 XLM", merchant: "M" });
    const es = manager.render("payment.failed", "es", { orderId: "O1", amount: "2 XLM", merchant: "M" });
    expect(es.locale).toBe("es");
    expect(es.subject).not.toBe(en.subject);
  });

  it("seeded templates validate cleanly", () => {
    const manager = new LocalizationManager();
    seedLocalizationManager(manager);
    const results = manager.validate();
    for (const { templateId, result } of results) {
      expect(result.every((r) => r.valid), `${templateId} should be valid`).toBe(true);
    }
  });
});

describe("detection with no requested locale", () => {
  it("uses the template fallback chain", () => {
    const manager = new LocalizationManager();
    const template = makeTemplate();
    template.fallbackChain = ["es"];
    template.translations.es = {
      subject: "Tienes {count, plural, one {# nueva actualización} other {# nuevas actualizaciones}} en el pedido {orderId}",
      html: "<p>Pedido {orderId}: {status}.</p>",
      text: "Pedido {orderId}: {status}.",
      placeholders: template.translations.en.placeholders,
    };
    manager.register(template);
    const result = manager.render("order_update", undefined, { count: 1, orderId: "O1", status: "x" });
    expect(result.locale).toBe("es");
  });
});
