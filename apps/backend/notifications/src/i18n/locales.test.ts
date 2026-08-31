// Issue #116 — Tests for the locale registry and fallback chains.
import { describe, it, expect } from "vitest";
import {
  LOCALE_CONFIGS,
  LOCALE_COUNT,
  getLocaleConfig,
  isRtlLocale,
  normalizeLocaleCode,
  resolveFallbackChain,
  supportedLocaleCodes,
} from "./locales.js";

describe("locale registry", () => {
  it("supports 20+ locales", () => {
    expect(LOCALE_COUNT).toBeGreaterThanOrEqual(20);
  });

  it("includes the core notification locales", () => {
    const codes = supportedLocaleCodes();
    for (const code of ["en", "es", "fr", "de", "pt-BR", "ja", "ar"]) {
      expect(codes).toContain(code);
    }
  });

  it("declares RTL locales", () => {
    for (const code of ["ar", "he", "fa", "ur"]) {
      expect(getLocaleConfig(code)?.rtl, `${code} should be RTL`).toBe(true);
    }
    expect(getLocaleConfig("en")?.rtl).toBe(false);
    expect(isRtlLocale("ar")).toBe(true);
    expect(isRtlLocale("en")).toBe(false);
  });

  it("every config is internally consistent", () => {
    const codes = new Set(supportedLocaleCodes().map((c) => c.toLowerCase()));
    for (const config of LOCALE_CONFIGS) {
      expect(config.code).toBeTruthy();
      expect(config.pluralRules.split(";").length).toBeGreaterThan(0);
      if (config.fallback) {
        expect(codes.has(config.fallback.toLowerCase()), `${config.code} fallback ${config.fallback} not registered`).toBe(true);
      }
    }
  });

  it("normalizes locale codes", () => {
    expect(normalizeLocaleCode("en-US")).toBe("en");
    expect(normalizeLocaleCode("en_us")).toBe("en");
    expect(normalizeLocaleCode("PT-BR")).toBe("pt-BR");
    expect(normalizeLocaleCode("xx")).toBeNull();
  });

  it("getLocaleConfig resolves case-insensitively and via primary subtag", () => {
    expect(getLocaleConfig("EN")?.code).toBe("en");
    expect(getLocaleConfig("pt-BR")?.code).toBe("pt-BR");
    expect(getLocaleConfig("fr-FR")?.code).toBe("fr");
    expect(getLocaleConfig("zz")).toBeUndefined();
  });
});

describe("fallback chains", () => {
  it("resolves a regional fallback to its base language", () => {
    expect(resolveFallbackChain("pt-BR")).toEqual(["pt-BR", "pt"]);
    expect(resolveFallbackChain("zh-TW")).toEqual(["zh-TW", "zh"]);
  });

  it("resolves a base locale to itself when it has no fallback", () => {
    expect(resolveFallbackChain("en")).toEqual(["en"]);
    expect(resolveFallbackChain("ar")).toEqual(["ar"]);
  });

  it("handles unknown locales gracefully", () => {
    expect(resolveFallbackChain("zz")).toEqual([]);
  });

  it("chains terminate (no cycles)", () => {
    for (const code of supportedLocaleCodes()) {
      const chain = resolveFallbackChain(code);
      expect(new Set(chain).size).toBe(chain.length);
      expect(chain[0]).toBe(code);
    }
  });
});
