import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EMBEDDING_DIMENSIONS,
  openAIEmbed,
  upsertMemoryWithEmbedding,
  searchMemories,
  validateUpsertMemoryInput,
  validateMemorySearchInput,
} from "./embeddingService.js";

function makeVector(length = EMBEDDING_DIMENSIONS, fill = 0.25): number[] {
  return Array.from({ length }, () => fill);
}

function makeResponse(status: number, body: unknown): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe("openAIEmbed", () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-openai-key";
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("throws when OPENAI_API_KEY is not configured", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(openAIEmbed("hello")).rejects.toThrow("OPENAI_API_KEY is not configured");
  });

  it("returns a 1536-dim embedding on success", async () => {
    const vector = makeVector();
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse(200, { data: [{ embedding: vector }] })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await openAIEmbed("size: medium");

    expect(result).toEqual(vector);
    expect(result).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer test-openai-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "text-embedding-3-small", input: "size: medium" }),
      })
    );
  });

  it("retries on 429 and 5xx with bounded exponential backoff and succeeds", async () => {
    const vector = makeVector();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(429, "rate limited"))
      .mockResolvedValueOnce(makeResponse(502, "bad gateway"))
      .mockResolvedValueOnce(makeResponse(503, "service unavailable"))
      .mockResolvedValueOnce(makeResponse(200, { data: [{ embedding: vector }] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });

    const result = await openAIEmbed("retry me", {
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 250,
      sleep,
    });

    expect(result).toEqual(vector);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([100, 200, 250]);
  });

  it("stops retrying after maxRetries is exhausted on 5xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(500, "internal error"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      openAIEmbed("always fails", { maxRetries: 2, baseDelayMs: 50, maxDelayMs: 500, sleep })
    ).rejects.toThrow("OpenAI embeddings error 500: internal error");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 50);
    expect(sleep).toHaveBeenNthCalledWith(2, 100);
  });

  it("does not retry on non-retryable 4xx errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(400, "invalid input"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      openAIEmbed("bad request", { maxRetries: 3, baseDelayMs: 50, sleep })
    ).rejects.toThrow("OpenAI embeddings error 400: invalid input");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rejects embeddings with wrong dimensions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse(200, { data: [{ embedding: makeVector(512) }] })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(openAIEmbed("wrong dim")).rejects.toThrow(
      "Unexpected embedding shape from OpenAI"
    );
  });

  it("rejects embeddings containing non-finite values", async () => {
    const badVector = makeVector();
    badVector[10] = Number.NaN;
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse(200, { data: [{ embedding: badVector }] })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(openAIEmbed("nan value")).rejects.toThrow(
      "Unexpected embedding shape from OpenAI"
    );
  });

  it("rejects responses with missing embedding array", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(200, { data: [] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(openAIEmbed("missing data")).rejects.toThrow(
      "Unexpected embedding shape from OpenAI"
    );
  });
});

describe("embeddingService helpers", () => {
  it("upsertMemoryWithEmbedding falls back to storing without vector when embed fails", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rowCount: 1,
        rows: [
          {
            id: "m1",
            user_id: "u1",
            category: "preference",
            key: "color",
            value: "blue",
            confidence: 1,
          },
        ],
      }),
    };
    const failingEmbed = vi.fn().mockRejectedValue(new Error("provider down"));

    const result = await upsertMemoryWithEmbedding(
      db as any,
      { userId: "u1", category: "preference", key: "color", value: "blue" },
      failingEmbed
    );

    expect(result.key).toBe("color");
    expect(failingEmbed).toHaveBeenCalledWith("color: blue");
  });

  it("searchMemories delegates to UserMemoryStore", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
    };
    const embed = vi.fn().mockResolvedValue(makeVector());

    const results = await searchMemories(
      db as any,
      { userId: "u1", promptText: "favorite color", limit: 3 },
      embed
    );

    expect(results).toEqual([]);
    expect(embed).toHaveBeenCalledWith("favorite color");
  });

  it("validates upsert and search inputs", () => {
    expect(
      validateUpsertMemoryInput({
        userId: "u1",
        category: "preference",
        key: "size",
        value: "L",
      })
    ).toEqual({
      userId: "u1",
      category: "preference",
      key: "size",
      value: "L",
      confidence: undefined,
    });

    expect(() =>
      validateUpsertMemoryInput({
        userId: "u1",
        category: "invalid",
        key: "size",
        value: "L",
      })
    ).toThrow("category must be one of: preference, constraint, address");

    expect(
      validateMemorySearchInput({ userId: "u1", promptText: "shoes", limit: 50 })
    ).toEqual({
      userId: "u1",
      promptText: "shoes",
      limit: 20,
      category: undefined,
    });
  });
});
