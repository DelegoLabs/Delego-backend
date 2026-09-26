/**
 * LLM client factory and provider failover.
 * Issue #261: switch provider via LLM_PROVIDER env var; auto-failover on error.
 */

import type { LLMClient, LLMClientConfig, LLMProviderName } from "./types.js";
import { OpenAIClient } from "./openai.js";
import { AnthropicClient } from "./anthropic.js";
import { GeminiClient } from "./gemini.js";

/**
 * Instantiate the appropriate LLM client for a given provider name.
 * API key is read from the environment when not supplied via config.
 */
export function createLLMClient(
  provider: LLMProviderName,
  config?: Partial<LLMClientConfig>
): LLMClient {
  const resolvedConfig = resolveConfig(provider, config);
  switch (provider) {
    case "openai":
      return new OpenAIClient(resolvedConfig);
    case "anthropic":
      return new AnthropicClient(resolvedConfig);
    case "gemini":
      return new GeminiClient(resolvedConfig);
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown LLM provider: ${_exhaustive}`);
    }
  }
}

/**
 * Create a client driven by the LLM_PROVIDER environment variable.
 * Falls back to "openai" when the variable is not set.
 */
export function createDefaultLLMClient(config?: Partial<LLMClientConfig>): LLMClient {
  const provider = (process.env["LLM_PROVIDER"] ?? "openai") as LLMProviderName;
  return createLLMClient(provider, config);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveConfig(
  provider: LLMProviderName,
  overrides?: Partial<LLMClientConfig>
): LLMClientConfig {
  const apiKey =
    overrides?.apiKey ??
    readEnvApiKey(provider);

  if (!apiKey) {
    throw new Error(
      `LLM API key for provider "${provider}" is not set. ` +
        `Configure ${apiKeyEnvVar(provider)} or pass it via config.`
    );
  }

  return {
    apiKey,
    maxRetries: overrides?.maxRetries,
    baseDelayMs: overrides?.baseDelayMs,
    timeoutMs: overrides?.timeoutMs,
  };
}

function apiKeyEnvVar(provider: LLMProviderName): string {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
  }
}

function readEnvApiKey(provider: LLMProviderName): string | undefined {
  return process.env[apiKeyEnvVar(provider)];
}
