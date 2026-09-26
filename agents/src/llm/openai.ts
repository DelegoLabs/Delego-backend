/**
 * OpenAI GPT client runtime.
 * Issues #9, #261: supports chat completions, function/tool calling, and exponential backoff.
 */

import type {
  LLMClient,
  LLMClientConfig,
  LLMRequestOptions,
  LLMResponse,
  LLMToolCallResponse,
} from "./types.js";

const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Rate-limit and server-error status codes that warrant a retry. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

interface OpenAIToolCall {
  id: string;
  function: { name: string; arguments: string };
}

interface OpenAIChatCompletionChoice {
  message?: {
    content?: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason?: string;
}

interface OpenAIChatCompletionResponse {
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: OpenAIChatCompletionChoice[];
}

export class OpenAIClient implements LLMClient {
  readonly provider = "openai" as const;

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

    const messages = options.systemPrompt
      ? [{ role: "system", content: options.systemPrompt }, ...options.messages]
      : options.messages;

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: options.maxTokens ?? 1024,
      temperature: options.temperature ?? 0.7,
    };

    // Attach tool definitions for function calling (#261)
    if (options.tools && options.tools.length > 0) {
      body["tools"] = options.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const response = await this.requestWithRetry(
      "https://api.openai.com/v1/chat/completions",
      body
    ) as OpenAIChatCompletionResponse;

    const inputTokens = response.usage?.prompt_tokens ?? 0;
    const outputTokens = response.usage?.completion_tokens ?? 0;
    const totalTokens = inputTokens + outputTokens;

    if (options.tokenBudget && totalTokens > options.tokenBudget) {
      throw new Error(
        `Token budget exceeded: used ${totalTokens}, budget ${options.tokenBudget}`
      );
    }

    const choice = response.choices?.[0];
    const rawFinish = choice?.finish_reason ?? "stop";
    const finishReason = rawFinish === "length"
      ? "length"
      : rawFinish === "tool_calls"
        ? "tool_calls"
        : "stop";

    // Parse tool calls if present
    const toolCalls: LLMToolCallResponse[] | undefined =
      choice?.message?.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: safeParseJson(tc.function.arguments),
      }));

    return {
      provider: "openai",
      model,
      content: choice?.message?.content ?? "",
      inputTokens,
      outputTokens,
      totalTokens,
      finishReason,
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
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
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
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
      throw new Error(`OpenAI API error ${res.status}: ${text}`);
    }

    return res.json() as Promise<Record<string, unknown>>;
  }
}

function safeParseJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { _raw: raw };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
