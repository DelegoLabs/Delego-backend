import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

vi.mock("@delegolabs/utils", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    route: (method: string, path: string, handler: unknown) => ({ method, path, handler }),
    createLogger: () => logger,
    generateId: () => "test-run-id",
  };
});

vi.mock("../middleware/auth.js", () => ({
  extractAuth: vi.fn(),
}));

vi.mock("../middleware/requestId.js", () => ({
  getRequestContext: vi.fn(() => ({ requestId: "req-123" })),
}));

vi.mock("../src/validation.js", () => ({
  validateSchema: vi.fn(),
  AgentChatSchema: {},
}));

vi.mock("../src/request.js", () => {
  class InvalidJsonError extends Error {}
  class BodyTooLargeError extends Error {}
  return {
    readJsonBody: vi.fn(),
    InvalidJsonError,
    BodyTooLargeError,
  };
});

vi.mock("../src/errors.js", () => ({
  badRequest: vi.fn((res: any, message: string) => {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: message }));
  }),
  unauthorized: vi.fn((res: any, message: string) => {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: message }));
  }),
  sendApiError: vi.fn((res: any, status: number, code: string, message: string) => {
    res.statusCode = status;
    res.end(JSON.stringify({ code, message }));
  }),
}));

vi.mock("../src/sse/clientPool.js", () => ({
  sseClientPool: {
    register: vi.fn(),
    remove: vi.fn(),
    touch: vi.fn(),
  },
}));

import {
  agentChatHandler,
  configureAgentChatService,
  formatSSE,
  streamEventToSSE,
  pipeLLMStreamToResponse,
  registerAgentChatRoutes,
  type LLMStreamGenerator,
} from "./agentChat.js";
import { extractAuth } from "../middleware/auth.js";
import { validateSchema } from "../src/validation.js";
import { readJsonBody, InvalidJsonError, BodyTooLargeError } from "../src/request.js";
import { badRequest, unauthorized, sendApiError } from "../src/errors.js";
import { sseClientPool } from "../src/sse/clientPool.js";

function createMockRes() {
  const res = new EventEmitter() as any;
  res.statusCode = 200;
  res.headersSent = false;
  res.destroyed = false;
  res.written = [] as string[];
  res.writeHead = vi.fn((status: number) => {
    res.statusCode = status;
    res.headersSent = true;
    return res;
  });
  res.write = vi.fn((chunk: string) => {
    res.written.push(chunk);
    return true;
  });
  res.end = vi.fn((chunk?: string) => {
    if (chunk) res.written.push(chunk);
    res.ended = true;
  });
  return res as ServerResponse & { written: string[]; ended?: boolean; destroyed: boolean; headersSent: boolean };
}

function createMockReq(): IncomingMessage {
  return new EventEmitter() as unknown as IncomingMessage;
}

async function* streamOf(...events: any[]): LLMStreamGenerator {
  for (const ev of events) yield ev;
}

describe("agentChat route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("formatSSE", () => {
    it("formats an event with JSON data", () => {
      const out = formatSSE({ event: "token", data: { text: "hi" } });
      expect(out).toBe('event: token\ndata: {"text":"hi"}\n\n');
    });
  });

  describe("streamEventToSSE", () => {
    it("maps each stream event type to an SSE frame", () => {
      expect(streamEventToSSE({ type: "token", text: "a" })).toContain("event: token");
      expect(streamEventToSSE({ type: "tool_start", tool: "t", input: {} })).toContain("event: tool_start");
      expect(streamEventToSSE({ type: "tool_end", tool: "t", output: {} })).toContain("event: tool_end");
      expect(streamEventToSSE({ type: "proposal", proposalId: "p", orderId: "o" })).toContain("event: proposal");
      expect(streamEventToSSE({ type: "done", runId: "r" })).toContain("event: done");
      expect(streamEventToSSE({ type: "error", message: "m" })).toContain("event: error");
    });

    it("returns null for unknown event types", () => {
      expect(streamEventToSSE({ type: "bogus" } as any)).toBeNull();
    });
  });

  describe("pipeLLMStreamToResponse", () => {
    it("writes frames and appends a done frame when the stream lacks one", async () => {
      const res = createMockRes();
      await pipeLLMStreamToResponse(res, streamOf({ type: "token", text: "x" }), "run-1");
      const joined = res.written.join("");
      expect(joined).toContain("event: token");
      expect(joined).toContain("event: done");
      expect(joined).toContain("run-1");
      expect(res.end).toHaveBeenCalled();
    });

    it("does not duplicate done when the stream emits one", async () => {
      const res = createMockRes();
      await pipeLLMStreamToResponse(res, streamOf({ type: "done", runId: "r" }), "r");
      const doneCount = res.written.filter((w) => w.includes("event: done")).length;
      expect(doneCount).toBe(1);
    });

    it("stops writing when the client disconnects", async () => {
      const res = createMockRes();
      res.destroyed = true;
      await pipeLLMStreamToResponse(res, streamOf({ type: "token", text: "x" }), "run-1");
      expect(res.write).not.toHaveBeenCalled();
    });

    it("emits error and done frames when the generator throws, then rethrows", async () => {
      const res = createMockRes();
      async function* failing(): LLMStreamGenerator {
        yield { type: "token", text: "a" };
        throw new Error("boom");
      }
      await expect(pipeLLMStreamToResponse(res, failing(), "run-err")).rejects.toThrow("boom");
      const joined = res.written.join("");
      expect(joined).toContain("event: error");
      expect(joined).toContain("boom");
      expect(joined).toContain("event: done");
      expect(res.end).toHaveBeenCalled();
    });
  });

  describe("agentChatHandler", () => {
    it("returns 400 when agentId is missing", async () => {
      const res = createMockRes();
      await agentChatHandler(createMockReq(), res, {});
      expect(badRequest).toHaveBeenCalledWith(res, expect.stringContaining("agentId"), expect.anything());
      expect(readJsonBody).not.toHaveBeenCalled();
    });

    it("returns 401 when the request is not authenticated", async () => {
      vi.mocked(extractAuth).mockReturnValue({ userId: undefined } as any);
      const res = createMockRes();
      await agentChatHandler(createMockReq(), res, { agentId: "agent-1" });
      expect(unauthorized).toHaveBeenCalledWith(res, "Authentication required", expect.anything());
      expect(readJsonBody).not.toHaveBeenCalled();
    });

    it("returns 400 when the body fails schema validation", async () => {
      vi.mocked(extractAuth).mockReturnValue({ userId: "u1" } as any);
      vi.mocked(readJsonBody).mockResolvedValue({ messages: "bad" });
      vi.mocked(validateSchema).mockReturnValue({ valid: false, errors: ["messages"] } as any);
      const res = createMockRes();
      await agentChatHandler(createMockReq(), res, { agentId: "agent-1" });
      expect(badRequest).toHaveBeenCalledWith(
        res,
        "Invalid request body",
        expect.anything(),
        ["messages"],
      );
      expect(res.writeHead).not.toHaveBeenCalled();
    });

    it("returns 400 for invalid JSON bodies before streaming starts", async () => {
      vi.mocked(extractAuth).mockReturnValue({ userId: "u1" } as any);
      vi.mocked(readJsonBody).mockRejectedValue(new InvalidJsonError("Unexpected token"));
      const res = createMockRes();
      await agentChatHandler(createMockReq(), res, { agentId: "agent-1" });
      expect(badRequest).toHaveBeenCalledWith(res, "Unexpected token", expect.anything());
    });

    it("returns 400 for oversized bodies before streaming starts", async () => {
      vi.mocked(extractAuth).mockReturnValue({ userId: "u1" } as any);
      vi.mocked(readJsonBody).mockRejectedValue(new BodyTooLargeError("Body too large"));
      const res = createMockRes();
      await agentChatHandler(createMockReq(), res, { agentId: "agent-1" });
      expect(badRequest).toHaveBeenCalledWith(res, "Body too large", expect.anything());
    });

    it("returns 500 AGENT_CHAT_FAILED when the stream provider throws before headers are sent", async () => {
      vi.mocked(extractAuth).mockReturnValue({ userId: "u1" } as any);
      vi.mocked(readJsonBody).mockResolvedValue({ messages: [] });
      vi.mocked(validateSchema).mockReturnValue({ valid: true } as any);
      configureAgentChatService({
        streamProvider: () => {
          throw new Error("provider down");
        },
      });
      const res = createMockRes();
      await agentChatHandler(createMockReq(), res, { agentId: "agent-1" });
      expect(sendApiError).toHaveBeenCalledWith(
        res,
        500,
        "AGENT_CHAT_FAILED",
        "provider down",
        expect.anything(),
      );
    });

    it("streams SSE frames and registers the client on the happy path", async () => {
      vi.mocked(extractAuth).mockReturnValue({ userId: "u1" } as any);
      vi.mocked(readJsonBody).mockResolvedValue({ messages: [{ role: "user", content: "hi" }] });
      vi.mocked(validateSchema).mockReturnValue({ valid: true } as any);
      configureAgentChatService({
        streamProvider: () => streamOf({ type: "token", text: "hello" }, { type: "done", runId: "test-run-id" }),
      });
      const res = createMockRes();
      await agentChatHandler(createMockReq(), res, { agentId: "agent-1" });
      expect(res.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          "Content-Type": "text/event-stream",
          "X-Run-Id": "test-run-id",
          "X-Request-Id": "req-123",
        }),
      );
      expect(sseClientPool.register).toHaveBeenCalledWith(
        expect.anything(),
        res,
        { sessionId: "test-run-id", userId: "u1" },
      );
      expect(res.written.join("")).toContain("hello");
      expect(sseClientPool.remove).toHaveBeenCalledWith("test-run-id");
    });
  });

  describe("registerAgentChatRoutes", () => {
    it("registers POST /api/v1/agents/:agentId/chat", () => {
      const routes = registerAgentChatRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        method: "POST",
        path: "/api/v1/agents/:agentId/chat",
      });
    });
  });
});
