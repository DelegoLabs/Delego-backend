/**
 * Text embedding helper for semantic product search.
 * Issue #263: embed a user query into a float vector using the configured
 * embedding model (OpenAI text-embedding-3-small by default).
 *
 * The implementation uses the OpenAI Embeddings REST API directly so the
 * gateway does not need to depend on the full openai npm SDK.
 */

const EMBED_API_URL = "https://api.openai.com/v1/embeddings";
const DEFAULT_EMBED_MODEL = "text-embedding-3-small";
const EMBED_DIMENSIONS = 1536;

interface EmbedResponse {
  data: Array<{ embedding: number[] }>;
}

/**
 * Embed a text string and return a float array suitable for pgvector queries.
 * Throws if the API key is not set or the upstream call fails.
 */
export async function embedText(text: string): Promise<number[]> {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set — cannot embed query");
  }

  const model = process.env["EMBED_MODEL"] ?? DEFAULT_EMBED_MODEL;

  const res = await fetch(EMBED_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: text, model }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`Embedding API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as EmbedResponse;
  const embedding = data.data[0]?.embedding;
  if (!embedding || embedding.length !== EMBED_DIMENSIONS) {
    throw new Error(
      `Unexpected embedding dimensions: expected ${EMBED_DIMENSIONS}, got ${embedding?.length ?? 0}`
    );
  }
  return embedding;
}
