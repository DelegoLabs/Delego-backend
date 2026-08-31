// Issue #116 — Tests for the ICU Message Format engine.
import { describe, it, expect } from "vitest";
import {
  formatIcu,
  formatIcuMessage,
  parseIcuMessage,
  extractIcuArguments,
  normalizeLegacyPlaceholders,
  IcuSyntaxError,
} from "./icu.js";

describe("simple arguments", () => {
  it("replaces {name} with the provided value", () => {
    expect(formatIcu("Hello {name}", { name: "Alice" }, "en")).toBe("Hello Alice");
  });

  it("coerces numbers and booleans to strings", () => {
    expect(formatIcu("Order {orderId}", { orderId: 12345 }, "en")).toBe("Order 12345");
  });

  it("reports missing arguments but keeps their marker", () => {
    const { text, missing } = formatIcuMessage("Hello {name}", {}, "en");
    expect(text).toBe("Hello {name}");
    expect(missing).toEqual(["name"]);
  });

  it("replaces the same placeholder multiple times", () => {
    expect(formatIcu("{x} + {x}", { x: 2 }, "en")).toBe("2 + 2");
  });
});

describe("pluralization", () => {
  it("uses one/other for English", () => {
    const message = "You have {count, plural, one {# message} other {# messages}}";
    expect(formatIcu(message, { count: 1 }, "en")).toBe("You have 1 message");
    expect(formatIcu(message, { count: 5 }, "en")).toBe("You have 5 messages");
  });

  it("uses =N exact matches ahead of categories", () => {
    const message =
      "Status: {count, plural, =0 {none} one {one} other {many}}";
    expect(formatIcu(message, { count: 0 }, "ja")).toBe("Status: none");
  });

  it("selects the dual category for Arabic", () => {
    const message =
      "لديك {count, plural, zero {لا شيء} one {رسالة واحدة} two {رسالتان} few {رسائل} many {رسالة} other {رسائل}}";
    expect(formatIcu(message, { count: 2 }, "ar")).toBe("لديك رسالتان");
  });

  it("uses the Intl plural rules for Russian (one/few/many)", () => {
    const message = "{count, plural, one {# файл} few {# файла} many {# файлов} other {# файл}}";
    expect(formatIcu(message, { count: 1 }, "ru")).toBe("1 файл");
    expect(formatIcu(message, { count: 2 }, "ru")).toBe("2 файла");
    expect(formatIcu(message, { count: 5 }, "ru")).toBe("5 файлов");
  });

  it("falls back to the other option when a category is missing", () => {
    const message = "{n, plural, one {#} other {#}}";
    expect(formatIcu(message, { n: 7 }, "en")).toBe("7");
  });

  it("substitutes # with the formatted number inside options", () => {
    const message = "{n, plural, one {You have # apple} other {You have # apples}}";
    expect(formatIcu(message, { n: 1000 }, "en")).toBe("You have 1,000 apples");
  });
});

describe("select", () => {
  const message = "{gender, select, male {He} female {She} other {They}}";

  it("picks the matching key", () => {
    expect(formatIcu(message, { gender: "female" }, "en")).toBe("She");
  });

  it("falls back to other", () => {
    expect(formatIcu(message, { gender: "unknown" }, "en")).toBe("They");
  });
});

describe("number / currency / percent", () => {
  it("formats numbers with locale grouping", () => {
    expect(formatIcu("{price, number}", { price: 1234.5 }, "en")).toBe("1,234.5");
  });

  it("formats integers without fraction digits", () => {
    expect(formatIcu("{price, number, integer}", { price: 1234.9 }, "en")).toBe("1,235");
  });

  it("formats currency", () => {
    expect(formatIcu("{amount, currency, USD}", { amount: 5 }, "en")).toBe("$5.00");
  });

  it("formats percent", () => {
    expect(formatIcu("{pct, percent}", { pct: 0.5 }, "en")).toBe("50%");
  });

  it("uses locale-aware digits", () => {
    const out = formatIcu("{n, number}", { n: 1234 }, "ar");
    expect(out).not.toBe("1234");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("date / time", () => {
  it("formats a date", () => {
    const out = formatIcu("{when, date, medium}", { when: "2026-08-28T12:00:00Z" }, "en");
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("2026");
  });

  it("formats a time", () => {
    const out = formatIcu("{when, time, short}", { when: "2026-08-28T12:00:00Z" }, "en");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("apostrophe escaping", () => {
  it("renders a literal apostrophe from a doubled one", () => {
    expect(formatIcu("It''s a {thing}", { thing: "deal" }, "en")).toBe("It's a deal");
  });

  it("treats quoted sections as literals", () => {
    expect(formatIcu("'{'is not a placeholder'}'", {}, "en")).toBe("{is not a placeholder}");
  });

  it("keeps an unmatched apostrophe as a literal", () => {
    expect(formatIcu("l'agent {id}", { id: "1" }, "fr")).toBe("l'agent 1");
  });
});

describe("syntax errors", () => {
  it("rejects an unterminated placeholder", () => {
    expect(() => parseIcuMessage("Hello {name")).toThrow(IcuSyntaxError);
  });

  it("rejects a stray closing brace", () => {
    expect(() => parseIcuMessage("Hello }")).toThrow(IcuSyntaxError);
  });

  it("rejects an empty argument name", () => {
    expect(() => parseIcuMessage("{}")).toThrow(IcuSyntaxError);
  });

  it("rejects an unsupported format type", () => {
    expect(() => parseIcuMessage("{x, bogus}")).toThrow(IcuSyntaxError);
  });

  it("rejects an invalid plural keyword", () => {
    expect(() => parseIcuMessage("{n, plural, banana {x} other {y}}")).toThrow(
      IcuSyntaxError
    );
  });

  it("accepts a structurally valid ICU message", () => {
    expect(() => parseIcuMessage("{n, plural, =0 {none} one {#} other {#}}")).not.toThrow();
  });
});

describe("introspection", () => {
  it("extracts argument names including nested ones", () => {
    const args = extractIcuArguments(
      "{name} bought {count, plural, one {# item} other {# items}} for {price, number}"
    );
    expect(args.sort()).toEqual(["count", "name", "price"]);
  });

  it("normalizes legacy {{key}} placeholders to ICU {key}", () => {
    expect(normalizeLegacyPlaceholders("Order {{orderId}} for {{amount}}")).toBe(
      "Order {orderId} for {amount}"
    );
  });
});
