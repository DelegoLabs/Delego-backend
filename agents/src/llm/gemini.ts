/**
 * Google Gemini client runtime.
 * Issue #261: supports chat completions, function calling, and exponential backoff
 * via the Gemini REST API (generateContent endpoint).
 */

import type {
  LLMClient,
  LLMClientConfig,
  LLMRequestOptions,
  LLMResponse,
  LLMToolCallResponse,
} from "./types.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-1.5-pro";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 30_000;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

interface GeminiContentPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
}

interface GeminiCandidate {
  content?: { parts?: GeminiContentPart[] };
  finishReason?: string;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

export class GeminiClient implements LLMClient {
  readonly provider = "gemini" as const;

  private readonly apiKey: string;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly timeoutMs: number;

  constructor(config: LLMClientConfig) {
    this.apiKey = config.apiKey;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelayMs = config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async chat(options: LLMRequestOptions): Promise<LLMResponse> {
    const model = options.model || DEFAULT_MODEL;

    // Build Gemini contents array — system instructions are handled separately.
    const systemInstruction = options.systemPrompt
      ?? options.messages.find((m) => m.role === "system")?.content;

    const userMessages = options.messages.filter((m) => m.role !== "system");

    const contents = userMessages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: options.maxTokens ?? 1024,
        temperature: options.temperature ?? 0.7,
      },
    };

    if (systemInstruction) {
      body["systemInstruction"] = { parts: [{ text: systemInstruction }] };
    }

    // Attach function declarations for function calling (#261)
    if (options.tools && options.tools.length > 0) {
      body["tools"] = [
        {
          functionDeclarations: options.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }

    const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${this.apiKey}`;
    const response = await this.requestWithRetry(url, body) as GeminiResponse;

    const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
    const totalTokens = response.usageMetadata?.totalTokenCount ?? (inputTokens + outputTokens);

    if (options.tokenBudget && totalTokens > options.tokenBudget) {
      throw new Error(
        `Token budget exceeded: used ${totalTokens}, budget ${options.tokenBudget}`
      );
    }

    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    // Extract text parts
    const content = parts
      .filter((p) => p.text !== undefined)
      .map((p) => p.text!)
      .join("");

    // Extract function call parts (#261)
    const toolCalls: LLMToolCallResponse[] = parts
      .filter((p) => p.functionCall !== undefined)
      .map((p, i) => ({
        // Gemini does not return a unique tool call ID, so we synthesise one.
        id: `gemini-tc-${i}`,
        name: p.functionCall!.name,
        arguments: p.functionCall!.args,
      }));

    const rawFinish = candidate?.finishReason ?? "STOP";
    const finishReason =
      rawFinish === "MAX_TOKENS"
        ? "length"
        : rawFinish === "FUNCTION_CALL" || toolCalls.length > 0
          ? "tool_calls"
          : "stop";

    return {
      provider: "gemini",
      model,
      content,
      inputTokens,
      outputTokens,
      totalTokens,
      finishReason,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  private async requestWithRetry(
    url: string,
    body: unknown,
    attempt = 1
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      if (RETRYABLE_STATUS.has(res.status) && attempt <= this.maxRetries) {
        const delay = this.baseDelayMs * 2 ** (attempt - 1);
        await sleep(delay);
        return this.requestWithRetry(url, body, attempt + 1);
      }
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Gemini API error ${res.status}: ${text}`);
    }

    return res.json() as Promise<Record<string, unknown>>;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
