/**
 * Anthropic Claude client runtime.
 * Issues #9, #261: supports chat, tool use (function calling), and exponential backoff.
 */

import type {
  LLMClient,
  LLMClientConfig,
  LLMRequestOptions,
  LLMResponse,
  LLMToolCallResponse,
} from "./types.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 30_000;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

interface AnthropicContentBlock {
  type: string;
  text?: string;
  // tool_use block fields
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export class AnthropicClient implements LLMClient {
  readonly provider = "anthropic" as const;

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

    // Anthropic keeps system prompt separate from the messages array.
    const systemPrompt =
      options.systemPrompt ??
      options.messages.find((m) => m.role === "system")?.content;

    const userMessages = options.messages.filter((m) => m.role !== "system");

    const body: Record<string, unknown> = {
      model,
      max_tokens: options.maxTokens ?? 1024,
      messages: userMessages,
    };
    if (systemPrompt) body["system"] = systemPrompt;
    if (options.temperature !== undefined) body["temperature"] = options.temperature;

    // Attach tool definitions for function calling (#261)
    if (options.tools && options.tools.length > 0) {
      body["tools"] = options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const response = await this.requestWithRetry(body);

    const inputTokens: number =
      (response.usage as Record<string, number>)?.input_tokens ?? 0;
    const outputTokens: number =
      (response.usage as Record<string, number>)?.output_tokens ?? 0;
    const totalTokens = inputTokens + outputTokens;

    if (options.tokenBudget && totalTokens > options.tokenBudget) {
      throw new Error(
        `Token budget exceeded: used ${totalTokens}, budget ${options.tokenBudget}`
      );
    }

    const contentBlocks = (response.content as AnthropicContentBlock[]) ?? [];

    // Extract text content
    const textBlock = contentBlocks.find((b) => b.type === "text");
    const content = textBlock?.text ?? "";

    // Extract tool-use blocks (#261)
    const toolCalls: LLMToolCallResponse[] = contentBlocks
      .filter((b) => b.type === "tool_use" && b.id && b.name)
      .map((b) => ({
        id: b.id!,
        name: b.name!,
        arguments: b.input ?? {},
      }));

    const stopReason = response.stop_reason as string | null;
    const finishReason =
      stopReason === "max_tokens"
        ? "length"
        : stopReason === "tool_use"
          ? "tool_calls"
          : "stop";

    return {
      provider: "anthropic",
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
    body: unknown,
    attempt = 1
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_API_VERSION,
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
        return this.requestWithRetry(body, attempt + 1);
      }
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Anthropic API error ${res.status}: ${text}`);
    }

    return res.json() as Promise<Record<string, unknown>>;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
