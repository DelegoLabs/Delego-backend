/**
 * @delegolabs/agents — Entry point
 * Issues #261, #262, #263, #264: LLM runtimes, tool registry, and buyer agent tools.
 */
import { createLogger } from "@delegolabs/utils";
import { startHttpServer } from "@delegolabs/utils";

// Issue #261: LLM client runtimes
export {
  OpenAIClient,
  AnthropicClient,
  GeminiClient,
  createLLMClient,
  createDefaultLLMClient,
} from "./llm/index.js";
export type {
  LLMClient,
  LLMRequestOptions,
  LLMResponse,
  LLMProviderName,
  LLMToolDefinition,
  LLMToolCallResponse,
} from "./llm/index.js";

// Issue #262: Tool execution registry
export {
  ToolRegistry,
  ToolValidationError,
  ToolPermissionError,
  ToolTimeoutError,
} from "./tools/index.js";
export type {
  AgentTool,
  AgentContext,
  AgentPermissionScope,
  ToolAuditEntry,
} from "./tools/index.js";

const SERVICE_NAME = "agents";
const DEFAULT_PORT = 3011;

const nodeEnv = process.env.NODE_ENV ?? "development";
const logLevel = process.env.LOG_LEVEL ?? "info";
const log = createLogger(SERVICE_NAME, logLevel);
const port = Number(process.env.AGENTS_PORT ?? DEFAULT_PORT);

log.info("Starting service", { port, nodeEnv });

startHttpServer({
  port,
  serviceName: SERVICE_NAME,
  routes: [],
});

// TODO: Wire routes, database, and domain logic
