import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChatArchivalServiceImpl } from "./service.js";
import type { DatabaseService } from "./database.js";
import type { S3ArchivalService } from "./s3.js";
import type { SummarizationService } from "./llm.js";
import type { IdleSession, ChatMessage } from "./types.js";

describe("ChatArchivalServiceImpl", () => {
  let mockDatabase: DatabaseService;
  let mockS3: S3ArchivalService;
  let mockLLM: SummarizationService;
  let service: ChatArchivalServiceImpl;

  beforeEach(() => {
    mockDatabase = {
      findIdleSessions: vi.fn(),
      getSessionById: vi.fn(),
      getSessionMessages: vi.fn(),
      saveArchivalSummary: vi.fn(),
      updateSessionArchived: vi.fn(),
      deleteSessionMessages: vi.fn(),
    };

    mockS3 = {
      archiveMessages: vi.fn(),
    };

    mockLLM = {
      summarizeSession: vi.fn(),
    };

    service = new ChatArchivalServiceImpl(mockDatabase, mockS3, mockLLM);
  });

  describe("archiveSession", () => {
    it("should archive a session successfully", async () => {
      const sessionId = "test-session-123";
      const mockSession: IdleSession = {
        id: "1",
        session_id: sessionId,
        user_id: "user-123",
        agent_id: "agent-456",
        message_count: 10,
        total_tokens: 5000,
        last_message_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };

      const mockMessages: ChatMessage[] = [
        {
          id: "1",
          session_id: sessionId,
          role: "user",
          content: "Hello",
          created_at: new Date().toISOString(),
        },
        {
          id: "2",
          session_id: sessionId,
          role: "assistant",
          content: "Hi there!",
          created_at: new Date().toISOString(),
        },
      ];

      vi.mocked(mockDatabase.getSessionById).mockResolvedValue(mockSession);
      vi.mocked(mockDatabase.getSessionMessages).mockResolvedValue(mockMessages);
      vi.mocked(mockLLM.summarizeSession).mockResolvedValue("Test summary");
      vi.mocked(mockS3.archiveMessages).mockResolvedValue("s3://bucket/key.json");
      vi.mocked(mockDatabase.deleteSessionMessages).mockResolvedValue(2);

      const result = await service.archiveSession(sessionId);

      expect(result.success).toBe(true);
      expect(result.sessionId).toBe(sessionId);
      expect(result.messageCount).toBe(2);
      expect(result.summaryText).toBe("Test summary");
      expect(result.archivedToS3Key).toBe("s3://bucket/key.json");

      expect(mockLLM.summarizeSession).toHaveBeenCalledWith(mockMessages);
      expect(mockS3.archiveMessages).toHaveBeenCalledWith(sessionId, mockMessages);
      expect(mockDatabase.saveArchivalSummary).toHaveBeenCalled();
      expect(mockDatabase.updateSessionArchived).toHaveBeenCalledWith(sessionId, "s3://bucket/key.json");
      expect(mockDatabase.deleteSessionMessages).toHaveBeenCalledWith(sessionId);
    });

    it("should handle session not found", async () => {
      const sessionId = "nonexistent-session";
      vi.mocked(mockDatabase.getSessionById).mockResolvedValue(null);

      const result = await service.archiveSession(sessionId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Session not found");
    });

    it("should handle already archived session", async () => {
      const sessionId = "archived-session";
      const mockSession: IdleSession = {
        id: "1",
        session_id: sessionId,
        user_id: "user-123",
        agent_id: "agent-456",
        message_count: 10,
        total_tokens: 5000,
        last_message_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        archived_at: new Date().toISOString(),
        archived_to_s3_key: "s3://bucket/old-key.json",
      };

      vi.mocked(mockDatabase.getSessionById).mockResolvedValue(mockSession);

      const result = await service.archiveSession(sessionId);

      expect(result.success).toBe(true);
      expect(result.archivedToS3Key).toBe("s3://bucket/old-key.json");
    });

    it("should handle empty session (no messages)", async () => {
      const sessionId = "empty-session";
      const mockSession: IdleSession = {
        id: "1",
        session_id: sessionId,
        user_id: "user-123",
        agent_id: "agent-456",
        message_count: 0,
        total_tokens: 0,
        last_message_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };

      vi.mocked(mockDatabase.getSessionById).mockResolvedValue(mockSession);
      vi.mocked(mockDatabase.getSessionMessages).mockResolvedValue([]);

      const result = await service.archiveSession(sessionId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("No messages found");
    });

    it("should handle dry run mode", async () => {
      const sessionId = "test-session";
      const mockSession: IdleSession = {
        id: "1",
        session_id: sessionId,
        user_id: "user-123",
        agent_id: "agent-456",
        message_count: 5,
        total_tokens: 2500,
        last_message_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };

      const mockMessages: ChatMessage[] = [
        {
          id: "1",
          session_id: sessionId,
          role: "user",
          content: "Test",
          created_at: new Date().toISOString(),
        },
      ];

      vi.mocked(mockDatabase.getSessionById).mockResolvedValue(mockSession);
      vi.mocked(mockDatabase.getSessionMessages).mockResolvedValue(mockMessages);

      const result = await service.archiveSession(sessionId, true);

      expect(result.success).toBe(true);
      expect(mockLLM.summarizeSession).not.toHaveBeenCalled();
      expect(mockS3.archiveMessages).not.toHaveBeenCalled();
      expect(mockDatabase.deleteSessionMessages).not.toHaveBeenCalled();
    });

    it("should handle LLM summarization failure", async () => {
      const sessionId = "test-session";
      const mockSession: IdleSession = {
        id: "1",
        session_id: sessionId,
        user_id: "user-123",
        agent_id: "agent-456",
        message_count: 5,
        total_tokens: 2500,
        last_message_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };

      const mockMessages: ChatMessage[] = [
        {
          id: "1",
          session_id: sessionId,
          role: "user",
          content: "Test",
          created_at: new Date().toISOString(),
        },
      ];

      vi.mocked(mockDatabase.getSessionById).mockResolvedValue(mockSession);
      vi.mocked(mockDatabase.getSessionMessages).mockResolvedValue(mockMessages);
      vi.mocked(mockLLM.summarizeSession).mockRejectedValue(new Error("LLM error"));

      const result = await service.archiveSession(sessionId);

      expect(result.success).toBe(false);
      expect(result.error).toBe("LLM error");
    });
  });

  describe("findAndArchiveIdleSessions", () => {
    it("should archive multiple idle sessions", async () => {
      const mockSessions: IdleSession[] = [
        {
          id: "1",
          session_id: "session-1",
          user_id: "user-1",
          agent_id: "agent-1",
          message_count: 10,
          total_tokens: 5000,
          last_message_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        },
        {
          id: "2",
          session_id: "session-2",
          user_id: "user-2",
          agent_id: "agent-2",
          message_count: 20,
          total_tokens: 10000,
          last_message_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        },
      ];

      vi.mocked(mockDatabase.findIdleSessions).mockResolvedValue(mockSessions);
      vi.mocked(mockDatabase.getSessionById).mockImplementation((sessionId) => {
        return Promise.resolve(mockSessions.find((s) => s.session_id === sessionId) ?? null);
      });
      vi.mocked(mockDatabase.getSessionMessages).mockResolvedValue([
        {
          id: "1",
          session_id: "test",
          role: "user",
          content: "Test",
          created_at: new Date().toISOString(),
        },
      ]);
      vi.mocked(mockLLM.summarizeSession).mockResolvedValue("Summary");
      vi.mocked(mockS3.archiveMessages).mockResolvedValue("s3://bucket/key.json");
      vi.mocked(mockDatabase.deleteSessionMessages).mockResolvedValue(1);

      const results = await service.findAndArchiveIdleSessions(30, 100);

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.success)).toBe(true);
      expect(mockDatabase.findIdleSessions).toHaveBeenCalledWith(30, 100);
    });

    it("should handle batch archival with failures", async () => {
      const mockSessions: IdleSession[] = [
        {
          id: "1",
          session_id: "session-1",
          user_id: "user-1",
          agent_id: "agent-1",
          message_count: 10,
          total_tokens: 5000,
          last_message_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        },
        {
          id: "2",
          session_id: "session-2",
          user_id: "user-2",
          agent_id: "agent-2",
          message_count: 20,
          total_tokens: 10000,
          last_message_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        },
      ];

      vi.mocked(mockDatabase.findIdleSessions).mockResolvedValue(mockSessions);
      vi.mocked(mockDatabase.getSessionById).mockImplementation((sessionId) => {
        if (sessionId === "session-1") {
          return Promise.resolve(mockSessions[0]);
        }
        return Promise.resolve(null); // session-2 not found
      });

      const results = await service.findAndArchiveIdleSessions(30, 100);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[1].error).toBe("Session not found");
    });
  });
});
