/**
 * LLM client runtimes — OpenAI, Anthropic, and Gemini.
 * Issues #9, #261: unified multi-provider interface with function calling.
 */

export type {
  LLMClient,
  LLMClientConfig,
  LLMRequestOptions,
  LLMResponse,
  LLMCompletionOptions,
  LLMCompletionResult,
  LLMToolDefinition,
  LLMToolCallResponse,
  LLMUsage,
  LLMMessage,
  LLMProviderName,
  LLMProvider,
  ChatMessage,
  TokenUsage,
} from "./types.js";

export { OpenAIClient } from "./openai.js";
export { AnthropicClient } from "./anthropic.js";
export { GeminiClient } from "./gemini.js";
export { createLLMClient, createDefaultLLMClient } from "./factory.js";
