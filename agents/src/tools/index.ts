/**
 * Agent tool registry exports.
 * Issue #262: type-safe registry with Zod validation, permissions, and timeouts.
 */

export type {
  AgentTool,
  AgentContext,
  AgentPermissionScope,
  ToolAuditEntry,
  AuditLogger,
} from "./registry.js";

export {
  ToolRegistry,
  ToolValidationError,
  ToolPermissionError,
  ToolTimeoutError,
} from "./registry.js";
