/**
 * Chat archival service - orchestrates the archival workflow.
 */
import { createLogger } from "@delegolabs/utils";
import type { DatabaseService } from "./database.js";
import type { S3ArchivalService } from "./s3.js";
import type { SummarizationService } from "./llm.js";
import type { ChatArchivalJobResult, IdleSession } from "./types.js";

const log = createLogger("chat-archival:service", process.env.LOG_LEVEL ?? "info");

export interface ChatArchivalService {
  archiveSession(sessionId: string, dryRun?: boolean): Promise<ChatArchivalJobResult>;
  findAndArchiveIdleSessions(olderThanDays: number, limit?: number, dryRun?: boolean): Promise<ChatArchivalJobResult[]>;
}

export class ChatArchivalServiceImpl implements ChatArchivalService {
  constructor(
    public readonly database: DatabaseService,
    private readonly s3: S3ArchivalService,
    private readonly llm: SummarizationService,
  ) {}

  async archiveSession(sessionId: string, dryRun = false): Promise<ChatArchivalJobResult> {
    const startTime = Date.now();
    log.info("Starting chat session archival", { sessionId, dryRun });

    try {
      // Get session info
      const session = await this.database.getSessionById(sessionId);
      if (!session) {
        log.warn("Session not found", { sessionId });
        return {
          success: false,
          sessionId,
          messageCount: 0,
          error: "Session not found",
        };
      }

      // Check if already archived
      if (session.archived_at) {
        log.info("Session already archived", { sessionId });
        return {
          success: true,
          sessionId,
          messageCount: session.message_count,
          archivedToS3Key: session.archived_to_s3_key ?? undefined,
        };
      }

      const messages = await this.database.getSessionMessages(sessionId);
      
      if (messages.length === 0) {
        log.warn("No messages found for session", { sessionId });
        return {
          success: false,
          sessionId,
          messageCount: 0,
          error: "No messages found",
        };
      }

      if (dryRun) {
        log.info("Dry run - would archive session", {
          sessionId,
          messageCount: messages.length,
          userId: session.user_id,
        });
        return {
          success: true,
          sessionId,
          messageCount: messages.length,
        };
      }

      // Generate summary
      log.info("Generating summary for session", { sessionId, messageCount: messages.length });
      const summaryText = await this.llm.summarizeSession(messages);

      // Archive to S3
      log.info("Archiving messages to S3", { sessionId, messageCount: messages.length });
      const s3Key = await this.s3.archiveMessages(sessionId, messages);

      // Save archival summary
      const archivedAt = new Date().toISOString();
      await this.database.saveArchivalSummary({
        sessionId,
        userId: session.user_id,
        messageCount: messages.length,
        summaryText,
        archivedToS3Key: s3Key,
        archivedAt,
      });

      // Update session as archived
      await this.database.updateSessionArchived(sessionId, s3Key);

      // Delete messages from hot storage
      const deletedCount = await this.database.deleteSessionMessages(sessionId);

      const duration = Date.now() - startTime;
      log.info("Chat session archival completed", {
        sessionId,
        messageCount: messages.length,
        deletedCount,
        durationMs: duration,
        s3Key,
      });

      return {
        success: true,
        sessionId,
        messageCount: messages.length,
        summaryText,
        archivedToS3Key: s3Key,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error("Chat session archival failed", {
        sessionId,
        error: errorMessage,
        durationMs: Date.now() - startTime,
      });
      return {
        success: false,
        sessionId,
        messageCount: 0,
        error: errorMessage,
      };
    }
  }

  async findAndArchiveIdleSessions(
    olderThanDays: number,
    limit = 100,
    dryRun = false,
  ): Promise<ChatArchivalJobResult[]> {
    log.info("Finding idle sessions for archival", { olderThanDays, limit, dryRun });

    const idleSessions = await this.database.findIdleSessions(olderThanDays, limit);
    log.info("Found idle sessions", { count: idleSessions.length });

    const results: ChatArchivalJobResult[] = [];

    for (const session of idleSessions) {
      const result = await this.archiveSession(session.session_id, dryRun);
      results.push(result);

      // Small delay to avoid overwhelming LLM/S3
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.filter((r) => !r.success).length;

    log.info("Batch archival completed", {
      total: results.length,
      success: successCount,
      failure: failureCount,
    });

    return results;
  }
}
