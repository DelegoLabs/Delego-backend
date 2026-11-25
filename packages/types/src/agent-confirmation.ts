/**
 * Issue #530 — Bidirectional WebSocket Protocol for Interactive Buyer Agent
 * Tool Confirmation.
 *
 * Defines the wire types exchanged between the gateway WebSocket handler and
 * the connected buyer client during an interactive agent confirmation session.
 */

// ─── Outbound: gateway → client ─────────────────────────────────────────────

/**
 * Sent by the gateway when an autonomous buyer agent invokes a tool that
 * exceeds its autonomous-execution budget and requires explicit user approval.
 */
export interface AgentToolConfirmationPrompt {
  type: "tool_confirmation_required";
  /** Unique identifier for this pending approval; echoed back in the response. */
  proposalId: string;
  /** The name of the agent tool awaiting approval. */
  toolName: "initialize_escrow" | "modify_budget";
  /** Full parameter set the tool will be called with if approved. */
  parameters: Record<string, unknown>;
  /** Estimated on-chain cost expressed in stroops (1 XLM = 10 000 000 stroops). */
  estimatedCostStroops: string;
  /** How many seconds the client has to respond before the prompt expires. */
  expiresInSeconds: number;
}

// ─── Inbound: client → gateway ──────────────────────────────────────────────

/**
 * Sent by the client to approve or reject a pending tool-confirmation prompt.
 */
export interface AgentConfirmationResponseFrame {
  type: "tool_confirmation_response";
  /** Must match the `proposalId` from the corresponding prompt. */
  proposalId: string;
  /** `true` to allow the tool call; `false` to cancel it. */
  confirmed: boolean;
  /**
   * Optional user-provided signature (e.g. a Stellar transaction envelope XDR)
   * that the agent uses to authorise the on-chain operation.
   */
  signature?: string;
}

// ─── Internal result type ────────────────────────────────────────────────────

/**
 * The resolved outcome of a pending confirmation, returned to the agent
 * execution thread after the client responds or the timeout fires.
 */
export interface AgentConfirmationResult {
  confirmed: boolean;
  signature?: string;
}
