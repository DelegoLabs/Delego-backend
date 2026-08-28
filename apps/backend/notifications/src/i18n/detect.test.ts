// Issue #116 — Tests for locale detection.
import { describe, it, expect } from "vitest";
import { parseAcceptLanguage, detectLocale } from "./detect.js";

describe("parseAcceptLanguage", () => {
  it("parses a header with q-values and sorts by weight", () => {
    const prefs = parseAcceptLanguage("fr-FR;q=0.9,en;q=1,es;q=0.8");
    expect(prefs.map((p) => p.tag)).toEqual(["en", "fr-FR", "es"]);
    expect(prefs.map((p) => p.q)).toEqual([1, 0.9, 0.8]);
  });

  it("ignores q=0 entries and empty parts", () => {
    expect(parseAcceptLanguage("en;q=0,es")).toEqual([{ tag: "es", q: 1 }]);
    expect(parseAcceptLanguage("")).toEqual([]);
  });
});

describe("detectLocale", () => {
  it("matches an exact available locale", () => {
    expect(detectLocale("en-US", ["en", "es"], "en")).toBe("en");
    expect(detectLocale(["pt-BR"], ["pt-BR", "pt", "en"], "en")).toBe("pt-BR");
  });

  it("matches the primary subtag when the region is unavailable", () => {
    expect(detectLocale("en-GB,es;q=0.8", ["en", "es"], "en")).toBe("en");
  });

  it("walks the fallback chain of an untranslated locale", () => {
    // zh-TW untranslated but zh is: chain zh-TW -> zh.
    expect(detectLocale("zh-TW", ["zh", "en"], "en")).toBe("zh");
  });

  it("returns the default when nothing matches", () => {
    expect(detectLocale("zz-ZZ", ["en", "es"], "en")).toBe("en");
  });

  it("honours preference order across languages", () => {
    expect(detectLocale("fr-FR,es;q=0.8", ["en", "es"], "en")).toBe("es");
  });
});
