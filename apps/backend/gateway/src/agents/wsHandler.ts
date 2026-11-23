/**
 * Issue #530 — WebSocket handler for interactive buyer-agent sessions.
 *
 * Manages the lifecycle of a single bidirectional WebSocket connection:
 *
 *   • On connection, authenticates the user via the `Authorization` query
 *     parameter (Bearer token) and registers the socket in the session map.
 *   • Sends `AgentToolConfirmationPrompt` frames to the client when the
 *     buyer agent needs approval before executing a tool.
 *   • Receives `AgentConfirmationResponseFrame` frames from the client and
 *     forwards the result to the waiting agent thread via `publishConfirmation`.
 *   • Cleans up all pending state on socket close or error.
 */

import { WebSocket, type RawData } from "ws";
import { createLogger, generateId } from "@delegolabs/utils";
import type {
  AgentToolConfirmationPrompt,
  AgentConfirmationResponseFrame,
} from "@delegolabs/types";
import { publishConfirmation } from "./confirmationStore.js";
import { extractAuth } from "../../middleware/auth.js";
import type { IncomingMessage } from "node:http";

const log = createLogger("gateway:ws-handler", process.env.LOG_LEVEL ?? "info");

/** How long in seconds a pending confirmation prompt is valid for. */
const CONFIRMATION_EXPIRES_SECONDS = 60;

// ─── Active session registry ─────────────────────────────────────────────────

interface AgentSession {
  sessionId: string;
  userId: string;
  socket: WebSocket;
  pendingProposals: Set<string>;
}

const sessions = new Map<string, AgentSession>();

/** Retrieve an active session by its ID. */
export function getSession(sessionId: string): AgentSession | undefined {
  return sessions.get(sessionId);
}

// ─── Outbound helpers ─────────────────────────────────────────────────────────

/**
 * Send a tool-confirmation prompt to the connected client.
 *
 * Returns the `proposalId` that the agent thread should pass to
 * `waitForConfirmation()`.
 */
export function sendConfirmationPrompt(
  sessionId: string,
  toolName: AgentToolConfirmationPrompt["toolName"],
  parameters: Record<string, unknown>,
  estimatedCostStroops: string
): string {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`No active agent session: ${sessionId}`);
  }

  const proposalId = generateId();

  const prompt: AgentToolConfirmationPrompt = {
    type: "tool_confirmation_required",
    proposalId,
    toolName,
    parameters,
    estimatedCostStroops,
    expiresInSeconds: CONFIRMATION_EXPIRES_SECONDS,
  };

  session.pendingProposals.add(proposalId);
  session.socket.send(JSON.stringify(prompt));

  log.info("Confirmation prompt sent", { sessionId, proposalId, toolName });

  return proposalId;
}

// ─── Inbound frame handling ───────────────────────────────────────────────────

function handleIncomingFrame(session: AgentSession, raw: RawData): void {
  let frame: unknown;
  try {
    frame = JSON.parse(raw.toString());
  } catch {
    log.warn("Received non-JSON WebSocket frame", { sessionId: session.sessionId });
    session.socket.send(
      JSON.stringify({ type: "error", code: "INVALID_JSON", message: "Frame must be valid JSON" })
    );
    return;
  }

  if (
    typeof frame !== "object" ||
    frame === null ||
    (frame as Record<string, unknown>)["type"] !== "tool_confirmation_response"
  ) {
    log.warn("Received unknown frame type", {
      sessionId: session.sessionId,
      type: (frame as Record<string, unknown>)?.["type"],
    });
    session.socket.send(
      JSON.stringify({ type: "error", code: "UNKNOWN_FRAME", message: "Unrecognised frame type" })
    );
    return;
  }

  const response = frame as AgentConfirmationResponseFrame;
  const { proposalId, confirmed, signature } = response;

  if (typeof proposalId !== "string" || typeof confirmed !== "boolean") {
    session.socket.send(
      JSON.stringify({
        type: "error",
        code: "INVALID_FRAME",
        message: "tool_confirmation_response requires string proposalId and boolean confirmed",
      })
    );
    return;
  }

  if (!session.pendingProposals.has(proposalId)) {
    log.warn("Received response for unknown proposal", {
      sessionId: session.sessionId,
      proposalId,
    });
    session.socket.send(
      JSON.stringify({
        type: "error",
        code: "UNKNOWN_PROPOSAL",
        message: `No pending proposal with id ${proposalId}`,
      })
    );
    return;
  }

  session.pendingProposals.delete(proposalId);

  log.info("Confirmation response received", {
    sessionId: session.sessionId,
    proposalId,
    confirmed,
  });

  publishConfirmation(proposalId, { confirmed, signature }).catch((err) => {
    log.error("Failed to publish confirmation", {
      proposalId,
      error: (err as Error).message,
    });
  });

  // Acknowledge receipt so the client knows the frame was processed.
  session.socket.send(
    JSON.stringify({ type: "tool_confirmation_acknowledged", proposalId })
  );
}

// ─── Connection lifecycle ─────────────────────────────────────────────────────

/**
 * Called by the WebSocket upgrade handler for each new connection.
 *
 * Authentication is performed against the `Authorization` header of the
 * HTTP upgrade request (standard Bearer token, same as REST endpoints).
 */
export function handleAgentConnection(socket: WebSocket, req: IncomingMessage): void {
  const auth = extractAuth(req);

  if (!auth.userId) {
    log.warn("Rejected unauthenticated WebSocket connection");
    socket.send(
      JSON.stringify({ type: "error", code: "UNAUTHORIZED", message: "Missing or invalid token" })
    );
    socket.close(4001, "Unauthorized");
    return;
  }

  const sessionId = generateId();
  const session: AgentSession = {
    sessionId,
    userId: auth.userId,
    socket,
    pendingProposals: new Set(),
  };

  sessions.set(sessionId, session);

  log.info("Agent WebSocket session opened", { sessionId, userId: auth.userId });

  socket.send(JSON.stringify({ type: "session_ready", sessionId }));

  socket.on("message", (raw: RawData) => {
    handleIncomingFrame(session, raw);
  });

  socket.on("close", (code: number, reason: Buffer) => {
    sessions.delete(sessionId);
    log.info("Agent WebSocket session closed", {
      sessionId,
      code,
      reason: reason.toString(),
      pendingProposals: session.pendingProposals.size,
    });
  });

  socket.on("error", (err: Error) => {
    log.error("Agent WebSocket error", { sessionId, error: err.message });
    sessions.delete(sessionId);
  });
}
