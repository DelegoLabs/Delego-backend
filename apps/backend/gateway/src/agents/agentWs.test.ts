/**
 * Issue #530 — Tests for the bidirectional WebSocket protocol for
 * interactive buyer-agent tool confirmation.
 *
 * Uses in-process WebSocket client/server pairs so no network is required.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";
import { attachAgentWebSocketServer } from "./wsServer.js";
import {
  publishConfirmation,
  waitForConfirmation,
  ConfirmationTimeoutError,
} from "./confirmationStore.js";
import { resetRedisPubSubManager } from "@delegolabs/utils";

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Force in-memory Redis mock for all tests.
process.env.NODE_ENV = "test";

const VALID_TOKEN = "Bearer test-token-valid";

/** Spin up a real HTTP + WS server on a random OS-assigned port. */
function createTestServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    attachAgentWebSocketServer(server);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

/** Open a WebSocket connection to the test server and return first message. */
function connect(port: number, token?: string): Promise<{ ws: WebSocket; firstMessage: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token) headers["authorization"] = token;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, { headers });

    ws.once("message", (data) => {
      try {
        resolve({ ws, firstMessage: JSON.parse(data.toString()) });
      } catch {
        reject(new Error("Invalid JSON in first message"));
      }
    });

    ws.once("error", reject);
  });
}

/** Collect the next `n` messages from a WebSocket. */
function collectMessages(ws: WebSocket, n: number): Promise<unknown[]> {
  return new Promise((resolve) => {
    const messages: unknown[] = [];
    const handler = (data: WebSocket.RawData) => {
      messages.push(JSON.parse(data.toString()));
      if (messages.length >= n) {
        ws.removeListener("message", handler);
        resolve(messages);
      }
    };
    ws.on("message", handler);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Agent WebSocket protocol (issue #530)", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    resetRedisPubSubManager();
    ({ server, port } = await createTestServer());
  });

  afterEach(() => {
    server.close();
  });

  // ── Authentication ──────────────────────────────────────────────────────

  it("rejects connections without an Authorization header", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);

    const errorFrame = await new Promise<unknown>((resolve) => {
      ws.once("message", (data) => resolve(JSON.parse(data.toString())));
    });

    expect((errorFrame as { type: string }).type).toBe("error");
    expect((errorFrame as { code: string }).code).toBe("UNAUTHORIZED");
  });

  it("accepts connections with a valid Bearer token and sends session_ready", async () => {
    const { ws, firstMessage } = await connect(port, VALID_TOKEN);
    expect((firstMessage as { type: string }).type).toBe("session_ready");
    expect(typeof (firstMessage as { sessionId: string }).sessionId).toBe("string");
    ws.close();
  });

  // ── Confirmation round-trip ─────────────────────────────────────────────

  it("publishes confirmation when client responds with confirmed:true", async () => {
    const { ws, firstMessage } = await connect(port, VALID_TOKEN);
    const sessionId = (firstMessage as { sessionId: string }).sessionId;

    expect(sessionId).toBeTruthy();

    // We import sendConfirmationPrompt dynamically to avoid circular test deps.
    const { sendConfirmationPrompt } = await import("./wsHandler.js");

    // Start waiting before sending the prompt so we don't miss the publish.
    const confirmationPromise = waitForConfirmation("__will-be-set__" as string, 5_000);

    // Collect the prompt frame the server will push to the client.
    const promptReceived = collectMessages(ws, 1);

    const proposalId = sendConfirmationPrompt(
      sessionId,
      "initialize_escrow",
      { amount: "100", assetCode: "USDC" },
      "1000000"
    );

    // Replace the placeholder promise with the real one now that we have the ID.
    const realConfirmation = waitForConfirmation(proposalId, 5_000);
    // Discard the placeholder (it will time out harmlessly in the background).
    confirmationPromise.catch(() => undefined);

    const [promptFrame] = await promptReceived;
    expect((promptFrame as AgentToolConfirmationPromptFrame).type).toBe(
      "tool_confirmation_required"
    );
    expect((promptFrame as AgentToolConfirmationPromptFrame).proposalId).toBe(proposalId);

    // Client confirms.
    const ackReceived = collectMessages(ws, 1);
    ws.send(
      JSON.stringify({
        type: "tool_confirmation_response",
        proposalId,
        confirmed: true,
        signature: "xdr-sig",
      })
    );

    const result = await realConfirmation;
    expect(result.confirmed).toBe(true);
    expect(result.signature).toBe("xdr-sig");

    const [ackFrame] = await ackReceived;
    expect((ackFrame as { type: string }).type).toBe("tool_confirmation_acknowledged");

    ws.close();
  });

  it("publishes confirmation with confirmed:false when client rejects", async () => {
    const { ws, firstMessage } = await connect(port, VALID_TOKEN);
    const sessionId = (firstMessage as { sessionId: string }).sessionId;

    const { sendConfirmationPrompt } = await import("./wsHandler.js");
    const promptReceived = collectMessages(ws, 1);
    const proposalId = sendConfirmationPrompt(
      sessionId,
      "modify_budget",
      { newBudget: "500" },
      "0"
    );
    const realConfirmation = waitForConfirmation(proposalId, 5_000);

    await promptReceived;

    ws.send(
      JSON.stringify({
        type: "tool_confirmation_response",
        proposalId,
        confirmed: false,
      })
    );

    const result = await realConfirmation;
    expect(result.confirmed).toBe(false);
    expect(result.signature).toBeUndefined();

    ws.close();
  });

  // ── Timeout ─────────────────────────────────────────────────────────────

  it("ConfirmationTimeoutError is thrown when no response arrives within the deadline", async () => {
    await expect(
      waitForConfirmation("non-existent-proposal", 100)
    ).rejects.toThrow(ConfirmationTimeoutError);
  });

  // ── Error frames ────────────────────────────────────────────────────────

  it("responds with error frame for non-JSON messages", async () => {
    const { ws } = await connect(port, VALID_TOKEN);
    const errorReceived = collectMessages(ws, 1);

    ws.send("not-json");

    const [errorFrame] = await errorReceived;
    expect((errorFrame as { type: string }).type).toBe("error");
    expect((errorFrame as { code: string }).code).toBe("INVALID_JSON");

    ws.close();
  });

  it("responds with error frame for unknown proposal IDs", async () => {
    const { ws } = await connect(port, VALID_TOKEN);
    const errorReceived = collectMessages(ws, 1);

    ws.send(
      JSON.stringify({
        type: "tool_confirmation_response",
        proposalId: "made-up-id",
        confirmed: true,
      })
    );

    const [errorFrame] = await errorReceived;
    expect((errorFrame as { code: string }).code).toBe("UNKNOWN_PROPOSAL");

    ws.close();
  });

  // ── Direct publishConfirmation ───────────────────────────────────────────

  it("publishConfirmation resolves waitForConfirmation immediately", async () => {
    const id = "test-direct-publish";
    const waiting = waitForConfirmation(id, 5_000);

    await publishConfirmation(id, { confirmed: true, signature: "sig-abc" });

    const result = await waiting;
    expect(result.confirmed).toBe(true);
    expect(result.signature).toBe("sig-abc");
  });
});

// ─── Local type alias for test readability ────────────────────────────────────

interface AgentToolConfirmationPromptFrame {
  type: "tool_confirmation_required";
  proposalId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  estimatedCostStroops: string;
  expiresInSeconds: number;
}
