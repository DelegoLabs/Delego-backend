// Issue #116 — Tests for translation memory.
import { describe, it, expect } from "vitest";
import { TranslationMemory } from "./memory.js";

describe("TranslationMemory", () => {
  it("stores entries and finds exact matches", () => {
    const memory = new TranslationMemory();
    memory.add({
      templateId: "escrow_released",
      sourceLocale: "en",
      targetLocale: "es",
      sourceText: "Escrow released for order {orderId}",
      targetText: "Depósito liberado para el pedido {orderId}",
      approved: true,
    });
    const matches = memory.find("Escrow released for order {orderId}", "en", "es");
    expect(matches.length).toBe(1);
    expect(matches[0].quality).toBe("exact");
    expect(matches[0].entry.targetText).toBe("Depósito liberado para el pedido {orderId}");
  });

  it("finds fuzzy matches based on significant words", () => {
    const memory = new TranslationMemory();
    memory.add({
      templateId: "escrow_released",
      sourceLocale: "en",
      targetLocale: "es",
      sourceText: "Escrow released for order {orderId}",
      targetText: "Depósito liberado para el pedido {orderId}",
      approved: true,
    });
    const matches = memory.find("Escrow released for order ORD-1", "en", "es");
    expect(matches.length).toBe(1);
    expect(matches[0].quality).toBe("fuzzy");
  });

  it("does not match unapproved entries", () => {
    const memory = new TranslationMemory();
    memory.add({
      templateId: "t",
      sourceLocale: "en",
      targetLocale: "fr",
      sourceText: "Hello",
      targetText: "Bonjour",
      approved: false,
    });
    expect(memory.find("Hello", "en", "fr").length).toBe(0);
  });

  it("scopes matches to the requested locale pair", () => {
    const memory = new TranslationMemory();
    memory.add({
      templateId: "t",
      sourceLocale: "en",
      targetLocale: "fr",
      sourceText: "Hello",
      targetText: "Bonjour",
      approved: true,
    });
    expect(memory.find("Hello", "en", "de").length).toBe(0);
  });

  it("tracks usage and approval state", () => {
    const memory = new TranslationMemory();
    const entry = memory.add({
      templateId: "t",
      sourceLocale: "en",
      targetLocale: "de",
      sourceText: "Hello",
      targetText: "Hallo",
      approved: true,
    });
    memory.recordUsage(entry.id);
    memory.recordUsage(entry.id);
    memory.setApproved(entry.id, false);
    const stored = memory.all()[0];
    expect(stored.usedCount).toBe(2);
    expect(stored.approved).toBe(false);
  });

  it("round-trips through JSON", () => {
    const memory = new TranslationMemory();
    const entry = memory.add({
      templateId: "t",
      sourceLocale: "en",
      targetLocale: "ar",
      sourceText: "Your payment failed",
      targetText: "فشل الدفع",
      approved: true,
    });
    const restored = new TranslationMemory();
    restored.fromJson(memory.toJson());
    expect(restored.count()).toBe(1);
    expect(restored.all()[0].id).toBe(entry.id);
  });
});
