/**
 * Embedding Service — Issue #532
 *
 * Generates 1536-dim text embeddings using OpenAI text-embedding-3-small and
 * persists them in the user_agent_memories table for cosine vector search.
 *
 * POST /api/v1/agent/memories        — upsert a memory and store its embedding
 * GET  /api/v1/agent/memories/search — semantic nearest-neighbour retrieval
 */
import { createLogger } from "@delegolabs/utils";
import { UserMemoryStore, type EmbedText } from "./store.js";
import type { Pool } from "pg";

const log = createLogger("buyer-agent:embedding", process.env.LOG_LEVEL ?? "info");

// ── Retry configuration ──────────────────────────────────────────────────────

export const EMBEDDING_MAX_RETRIES = 3;
export const EMBEDDING_BASE_DELAY_MS = 250;
export const EMBEDDING_MAX_DELAY_MS = 4000;

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── OpenAI embedding client ──────────────────────────────────────────────────

/**
 * Calls the OpenAI embeddings endpoint and returns a 1536-dim vector.
 * Retries 429/5xx responses with bounded exponential backoff.
 * Throws when OPENAI_API_KEY is absent or the request fails permanently.
 */
export async function openAIEmbed(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= EMBEDDING_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(
        EMBEDDING_BASE_DELAY_MS * 2 ** (attempt - 1),
        EMBEDDING_MAX_DELAY_MS
      );
      log.warn("Retrying OpenAI embedding request", { attempt, delayMs: delay });
      await sleep(delay);
    }

    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
    });

    if (!response.ok) {
      const body = await response.text();
      lastError = new Error(`OpenAI embeddings error ${response.status}: ${body}`);
      if (isRetryableStatus(response.status) && attempt < EMBEDDING_MAX_RETRIES) {
        continue;
      }
      throw lastError;
    }

    const json = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };

    const embedding = json.data[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== 1536) {
      throw new Error("Unexpected embedding shape from OpenAI");
    }

    return embedding;
  }

  throw lastError ?? new Error("OpenAI embedding request failed");
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UpsertMemoryWithEmbeddingInput {
  userId: string;
  category: "preference" | "constraint" | "address";
  key: string;
  value: string;
  confidence?: number;
}

export interface MemorySearchInput {
  userId: string;
  promptText: string;
  limit?: number;
  category?: "preference" | "constraint" | "address";
}

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * Upserts a memory and generates + stores its embedding so it is immediately
 * searchable via cosine distance.
 */
export async function upsertMemoryWithEmbedding(
  db: Pool,
  input: UpsertMemoryWithEmbeddingInput,
  embedText: EmbedText = openAIEmbed
) {
  let embedding: number[] | undefined;

  try {
    embedding = await embedText(`${input.key}: ${input.value}`);
  } catch (err) {
    log.warn("Could not generate embedding; storing without vector", {
      userId: input.userId,
      key: input.key,
      error: (err as Error).message,
    });
  }

  const store = new UserMemoryStore(db, embedText);
  return store.upsertMemory({ ...input, embedding });
}

/**
 * Returns the top-N memories most semantically similar to `promptText`.
 * Falls back to keyword search when the OpenAI API is unavailable.
 */
export async function searchMemories(
  db: Pool,
  input: MemorySearchInput,
  embedText: EmbedText = openAIEmbed
) {
  const store = new UserMemoryStore(db, embedText);
  return store.getRelevantMemories(input.userId, input.promptText, {
    limit: input.limit ?? 5,
    category: input.category,
  });
}

// ── Validation ────────────────────────────────────────────────────────────────

const VALID_CATEGORIES = new Set(["preference", "constraint", "address"]);

export function validateUpsertMemoryInput(
  raw: Record<string, unknown>
): UpsertMemoryWithEmbeddingInput {
  for (const field of ["userId", "category", "key", "value"] as const) {
    if (!raw[field] || typeof raw[field] !== "string") {
      throw new Error(`${field} is required`);
    }
  }
  if (!VALID_CATEGORIES.has(raw.category as string)) {
    throw new Error("category must be one of: preference, constraint, address");
  }
  return {
    userId: raw.userId as string,
    category: raw.category as "preference" | "constraint" | "address",
    key: raw.key as string,
    value: raw.value as string,
    confidence: raw.confidence !== undefined ? Number(raw.confidence) : undefined,
  };
}

export function validateMemorySearchInput(
  raw: Record<string, unknown>
): MemorySearchInput {
  if (!raw.userId || typeof raw.userId !== "string") throw new Error("userId is required");
  if (!raw.promptText || typeof raw.promptText !== "string") throw new Error("promptText is required");
  return {
    userId: raw.userId,
    promptText: raw.promptText,
    limit: raw.limit !== undefined ? Math.min(20, Math.max(1, Number(raw.limit))) : 5,
    category: VALID_CATEGORIES.has(raw.category as string)
      ? (raw.category as "preference" | "constraint" | "address")
      : undefined,
  };
}
