/**
 * Agent Tool Registry & Secure Sandboxed Invoker.
 * Issue #262: type-safe registry with Zod validation, permission enforcement,
 * execution timeouts (10 s), and audit logging.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Context & permissions
// ---------------------------------------------------------------------------

export type AgentPermissionScope =
  | "read_only"
  | "propose_order"
  | "execute_payment";

/** Runtime context injected into every tool execution. */
export interface AgentContext {
  userId: string;
  walletAddress: string;
  delegationId?: string;
  spendingLimitRemainingStroops: string;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodSchema<TInput>;
  requiredPermission: AgentPermissionScope;
  execute: (input: TInput, context: AgentContext) => Promise<TOutput>;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface ToolAuditEntry {
  toolName: string;
  userId: string;
  delegationId?: string;
  input: unknown;
  output: unknown;
  success: boolean;
  error?: string;
  durationMs: number;
  executedAt: string;
}

/** Persist-to-database callback. Implementations should write to the audit log table. */
export type AuditLogger = (entry: ToolAuditEntry) => Promise<void>;

/** In-memory no-op used when no persistent logger is configured. */
const noopAuditLogger: AuditLogger = async () => {};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ToolValidationError extends Error {
  readonly issues: z.ZodIssue[];
  constructor(toolName: string, issues: z.ZodIssue[]) {
    super(
      `Invalid input for tool "${toolName}": ${issues.map((i) => i.message).join("; ")}`
    );
    this.name = "ToolValidationError";
    this.issues = issues;
  }
}

export class ToolPermissionError extends Error {
  constructor(
    toolName: string,
    required: AgentPermissionScope,
    context: AgentContext
  ) {
    super(
      `Permission denied for tool "${toolName}": requires "${required}" scope (userId=${context.userId})`
    );
    this.name = "ToolPermissionError";
  }
}

export class ToolTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    super(`Tool "${toolName}" timed out after ${timeoutMs} ms`);
    this.name = "ToolTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Permission hierarchy
// ---------------------------------------------------------------------------

/** Numeric rank — higher rank includes lower-rank permissions. */
const PERMISSION_RANK: Record<AgentPermissionScope, number> = {
  read_only: 0,
  propose_order: 1,
  execute_payment: 2,
};

function contextGrantsPermission(
  required: AgentPermissionScope,
  context: AgentContext
): boolean {
  const contextScope = deriveContextScope(context);
  return PERMISSION_RANK[contextScope] >= PERMISSION_RANK[required];
}

function deriveContextScope(context: AgentContext): AgentPermissionScope {
  if (!context.delegationId) return "read_only";
  const remaining = BigInt(context.spendingLimitRemainingStroops);
  if (remaining > 0n) return "execute_payment";
  return "propose_order";
}

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

const TOOL_EXECUTION_TIMEOUT_MS = 10_000;

interface RegisteredEntry<TInput = unknown, TOutput = unknown> {
  tool: AgentTool<TInput, TOutput>;
}

/**
 * Central registry for all agent tools.
 *
 * Usage:
 * ```ts
 * const registry = new ToolRegistry();
 * registry.register(myTool);
 * const result = await registry.execute("myTool", rawInput, agentContext);
 * ```
 */
export class ToolRegistry {
  private readonly entries = new Map<string, RegisteredEntry>();
  private readonly inMemoryLog: ToolAuditEntry[] = [];
  private readonly auditLogger: AuditLogger;

  constructor(auditLogger: AuditLogger = noopAuditLogger) {
    this.auditLogger = auditLogger;
  }

  // ---- Registration -------------------------------------------------------

  register<TInput, TOutput>(tool: AgentTool<TInput, TOutput>): void {
    if (this.entries.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.entries.set(tool.name, { tool: tool as AgentTool<unknown, unknown> });
  }

  listTools(): Array<{
    name: string;
    description: string;
    requiredPermission: AgentPermissionScope;
  }> {
    return Array.from(this.entries.values()).map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      requiredPermission: tool.requiredPermission,
    }));
  }

  // ---- Execution ----------------------------------------------------------

  async execute(
    toolName: string,
    rawInput: unknown,
    context: AgentContext
  ): Promise<unknown> {
    const registered = this.entries.get(toolName);
    if (!registered) {
      throw new Error(`Unknown tool: "${toolName}"`);
    }

    const { tool } = registered;

    // 1. Permission check — before audit so unauthorised requests don't log
    //    their raw input (potential data-leak concern).
    if (!contextGrantsPermission(tool.requiredPermission, context)) {
      throw new ToolPermissionError(toolName, tool.requiredPermission, context);
    }

    // 2. Validation + execution are both wrapped in the audit boundary so
    //    validation failures also produce an audit entry.
    const start = Date.now();
    let output: unknown = null;
    let success = false;
    let errorMessage: string | undefined;
    let parsedInput: unknown = rawInput;

    try {
      // 2a. Zod input validation
      const parseResult = tool.inputSchema.safeParse(rawInput);
      if (!parseResult.success) {
        throw new ToolValidationError(toolName, parseResult.error.issues);
      }
      parsedInput = parseResult.data;

      // 2b. Sandboxed execution with timeout
      output = await executeWithTimeout(
        () => tool.execute(parsedInput, context),
        TOOL_EXECUTION_TIMEOUT_MS,
        toolName
      );
      success = true;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const auditEntry: ToolAuditEntry = {
        toolName,
        userId: context.userId,
        delegationId: context.delegationId,
        input: parsedInput,
        output,
        success,
        durationMs: Date.now() - start,
        executedAt: new Date().toISOString(),
        ...(errorMessage ? { error: errorMessage } : {}),
      };
      this.inMemoryLog.push(auditEntry);
      // Fire-and-forget to database; errors here must not surface to callers.
      this.auditLogger(auditEntry).catch(() => {});
    }

    return output;
  }

  // ---- Audit log (in-memory, primarily for tests) -------------------------

  getAuditLog(): ToolAuditEntry[] {
    return [...this.inMemoryLog];
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function executeWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  toolName: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ToolTimeoutError(toolName, timeoutMs)),
      timeoutMs
    );

    fn()
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
