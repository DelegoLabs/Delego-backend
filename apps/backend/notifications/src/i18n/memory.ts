// Issue #116 — Translation memory. Stores previously approved translation
// segments so translators can reuse them instead of re-translating the same
// string, and callers can get consistent wording across templates.

export interface TranslationMemoryEntry {
  id: string;
  templateId: string;
  sourceLocale: string;
  targetLocale: string;
  sourceText: string;
  targetText: string;
  approved: boolean;
  usedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryMatch {
  entry: TranslationMemoryEntry;
  /** How good the match is: "exact" or "fuzzy". */
  quality: "exact" | "fuzzy";
  /** Normalised source text for display. */
  key: string;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

let entrySeq = 0;

function generateId(): string {
  entrySeq += 1;
  return `tm_${Date.now().toString(36)}_${entrySeq}`;
}

/**
 * In-memory translation memory. Entries can be persisted to JSON via
 * `toJson` / `fromJson` and stored wherever the service keeps state.
 */
export class TranslationMemory {
  private entries = new Map<string, TranslationMemoryEntry>();

  private static readonly STOPWORDS = new Set([
    "a",
    "an",
    "the",
    "of",
    "for",
    "and",
    "or",
    "to",
    "in",
    "on",
    "your",
    "our",
    "has",
    "been",
    "will",
  ]);

  add(
    entry: Omit<TranslationMemoryEntry, "id" | "usedCount" | "createdAt" | "updatedAt">
  ): TranslationMemoryEntry {
    const id = generateId();
    const stored: TranslationMemoryEntry = {
      ...entry,
      id,
      usedCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.entries.set(id, stored);
    return stored;
  }

  private normalizeContentWords(text: string): Set<string> {
    const words = normalizeText(text)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 0 && !TranslationMemory.STOPWORDS.has(w));
    return new Set(words);
  }

  /** Find exact matches first, then fuzzy (shared significant words). */
  find(
    sourceText: string,
    sourceLocale: string,
    targetLocale: string
  ): MemoryMatch[] {
    const candidates = [...this.entries.values()].filter(
      (e) =>
        e.approved &&
        e.sourceLocale === sourceLocale &&
        e.targetLocale === targetLocale
    );

    const key = normalizeText(sourceText);
    const exact = candidates.filter((e) => normalizeText(e.sourceText) === key);
    if (exact.length > 0) {
      return exact.map((e) => ({ entry: e, quality: "exact", key }));
    }

    const sourceWords = this.normalizeContentWords(sourceText);
    const scored = candidates
      .map((e) => {
        const targetWords = this.normalizeContentWords(e.sourceText);
        let overlap = 0;
        for (const w of sourceWords) {
          if (targetWords.has(w)) overlap++;
        }
        const ratio =
          sourceWords.size > 0 ? overlap / sourceWords.size : 0;
        return { entry: e, ratio };
      })
      .filter(({ ratio }) => ratio >= 0.6)
      .sort((a, b) => b.ratio - a.ratio);

    return scored.map(({ entry }) => ({ entry, quality: "fuzzy" as const, key }));
  }

  recordUsage(id: string): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.usedCount += 1;
      entry.updatedAt = new Date().toISOString();
    }
  }

  setApproved(id: string, approved: boolean): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.approved = approved;
      entry.updatedAt = new Date().toISOString();
    }
  }

  all(): TranslationMemoryEntry[] {
    return [...this.entries.values()];
  }

  count(): number {
    return this.entries.size;
  }

  toJson(): string {
    return JSON.stringify([...this.entries.values()]);
  }

  fromJson(json: string): void {
    const parsed = JSON.parse(json) as TranslationMemoryEntry[];
    this.entries.clear();
    for (const entry of parsed) {
      this.entries.set(entry.id, entry);
    }
  }
}

/** Shared singleton used across the notification service. */
export const translationMemory = new TranslationMemory();
